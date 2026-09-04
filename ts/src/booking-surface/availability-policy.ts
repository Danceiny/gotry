import type { ActionReceipt, BookingReadAction, BookingWorkspaceSnapshot, OfferCriteria } from './contracts.ts'
import { createHash } from 'node:crypto'

/** Typed CheckAvail budget. This module never parses prose or retries a supplier. */
export const MAX_HOTELS_PER_TASK = 5
export const MAX_OFFERS_PER_HOTEL_GENERATION = 3
export const MAX_OFFER_CHECKS_PER_HOTEL = 2
export const MAX_OFFER_QUERIES_PER_HOTEL = 2

export type AvailabilityHotelStatus = 'unvisited' | 'active' | 'negative' | 'confirmed' | 'inconclusive'
export type AvailabilityGenerationSource =
  | { kind: 'query_receipt'; actionId: string; receiptDigest: string; workspaceRevision: number }
  | { kind: 'workspace_snapshot'; workspaceDigest: string; workspaceRevision: number }
export interface AvailabilityGeneration { generationId: string; source: AvailabilityGenerationSource; offerSetDigest: string; orderedOfferRefs: string[]; evidence: 'complete' | 'partial'; valid: boolean }
export interface AvailabilityHotelState {
  hotelRef: string; status: AvailabilityHotelStatus; checksIssued: number; offerQueriesIssued: number; generationNo: number
  currentGeneration?: AvailabilityGeneration
  /** Compatibility projection for callers needing current refs only. */
  generation: number; currentOfferRefs: string[]; invalidatedOfferRefs: string[]; checkCount: number; freshOffersRequired: boolean
  tombstonedOfferRefs: string[]; tombstonedOfferVersionRefs: string[]
  lastEvidence: 'none' | 'confirmed' | 'unavailable' | 'inconclusive'
}
export interface AvailabilityAttempt { actionId: string; hotelRef: string; offerRef: string; offerVersionRef: string; generation: number; ordinal: number; workspaceRevision: number }
export interface AvailabilityQueryReservation { actionId: string; hotelRefs: string[]; workspaceRevision: number }
export interface AvailabilityExhaustion {
  code: 'availability_confirmed' | 'availability_exhausted_complete' | 'availability_exhausted_inconclusive'
  hotelRefs: string[]; reason: 'no_current_offers' | 'check_limit_reached' | 'confirmed'; evidence: 'conclusive' | 'inconclusive'
}
export interface AvailabilityPolicyState {
  initialized: boolean; recoveryStarted: boolean
  availabilityPhase: 'need_offers' | 'waiting_offers' | 'need_check' | 'waiting_check' | 'terminal'
  activeHotelOrdinal: number; hotelRefs: string[]; hotels: Record<string, AvailabilityHotelState>; attempts: AvailabilityAttempt[]; queryReservations: AvailabilityQueryReservation[]; terminal?: AvailabilityExhaustion
  recoveryId?: string; criteria?: OfferCriteria; criteriaDigest?: string; candidateSetDigest?: string; lastQueryHotelRefs?: string[]; lastQueryCriteriaDigest?: string
  /** Receipt-authoritative mapping used when a shortlist ref is no longer loaded. */
  lastQueryOfferHotels?: Record<string, string>; lastQuerySourceActionId?: string; lastQuerySourceReceiptDigest?: string; lastQueryWorkspaceRevision?: number
}
export type AvailabilityPolicyDecision =
  | { ok: true; hotelRef: string; offerRef: string; offerVersionRef: string; checkCount: number; generation: number }
  | { ok: false; code: 'hotel_unknown' | 'offer_not_loaded' | 'offers_refresh_required' | 'hotel_check_limit_reached' | 'availability_exhausted' | 'generation_invalid' | 'hotel_not_active' }

type AvailabilityActionLike = { kind: BookingReadAction['kind']; actionId: string; input: Record<string, any>; expectedRevision?: number }

function unique(values: readonly string[]): string[] { return [...new Set(values)] }
export function assertWorkspaceLoadedOfferRefsUnique(workspace: BookingWorkspaceSnapshot): void {
  if (workspace.loadedOffers.length !== new Set(workspace.loadedOffers.map((offer) => offer.offerRef)).size) throw new Error('availability_duplicate_offer_ref')
  if (workspace.loadedOffers.length !== new Set(workspace.loadedOffers.map((offer) => offer.offerVersionRef)).size) throw new Error('availability_duplicate_offer_version_ref')
}
function stable(value: unknown): unknown { if (Array.isArray(value)) return value.map(stable); if (!value || typeof value !== 'object') return value; return Object.fromEntries(Object.keys(value as Record<string, unknown>).sort().map((key) => [key, stable((value as Record<string, unknown>)[key])])); }
export function digest(value: unknown): string { return createHash('sha256').update(JSON.stringify(stable(value))).digest('hex') }
function workspaceDigest(workspace: BookingWorkspaceSnapshot): string { const { contextRef: _context, ...bound } = workspace as unknown as Record<string, unknown>; return digest(bound) }
function offerRefsForHotel(workspace: BookingWorkspaceSnapshot, hotelRef: string, selectedOfferRef?: string): string[] {
  const refs = unique(workspace.loadedOffers.filter((offer) => offer.hotelRef === hotelRef).map((offer) => offer.offerRef))
  if (selectedOfferRef) return unique([selectedOfferRef, ...refs]).slice(0, MAX_OFFERS_PER_HOTEL_GENERATION)
  if (refs.length > MAX_OFFERS_PER_HOTEL_GENERATION) throw new Error('availability_offer_limit_exceeded')
  return refs
}
function loadedOfferVersion(workspace: BookingWorkspaceSnapshot, offerRef: string, offerVersionRef: string) { return workspace.loadedOffers.find((offer) => offer.offerRef === offerRef && offer.offerVersionRef === offerVersionRef) }
function legalOfferRefsForHotel(workspace: BookingWorkspaceSnapshot, hotel: AvailabilityHotelState, refs: readonly string[]): string[] {
  const legal = refs.filter((ref) => {
    if (hotel.tombstonedOfferRefs.includes(ref)) return false
    const loaded = workspace.loadedOffers.find((offer) => offer.offerRef === ref && offer.hotelRef === hotel.hotelRef)
    return Boolean(loaded && !hotel.tombstonedOfferVersionRefs.includes(loaded.offerVersionRef))
  })
  if (legal.length > MAX_OFFERS_PER_HOTEL_GENERATION) throw new Error('availability_offer_limit_exceeded')
  return unique(legal)
}
function copyHotel(hotel: AvailabilityHotelState): AvailabilityHotelState {
  return { ...hotel, currentOfferRefs: [...hotel.currentOfferRefs], invalidatedOfferRefs: [...hotel.invalidatedOfferRefs], tombstonedOfferRefs: [...hotel.tombstonedOfferRefs], tombstonedOfferVersionRefs: [...hotel.tombstonedOfferVersionRefs], ...(hotel.currentGeneration ? { currentGeneration: { ...hotel.currentGeneration, orderedOfferRefs: [...hotel.currentGeneration.orderedOfferRefs] } } : {}) }
}
function copyState(state: AvailabilityPolicyState): AvailabilityPolicyState {
  return { ...state, ...(state.criteria ? { criteria: structuredClone(state.criteria) } : {}), hotelRefs: [...state.hotelRefs], hotels: Object.fromEntries(Object.entries(state.hotels).map(([ref, hotel]) => [ref, copyHotel(hotel)])), attempts: state.attempts.map((attempt) => ({ ...attempt })), queryReservations: state.queryReservations.map((query) => ({ ...query, hotelRefs: [...query.hotelRefs] })), ...(state.lastQueryHotelRefs ? { lastQueryHotelRefs: [...state.lastQueryHotelRefs] } : {}), ...(state.lastQueryOfferHotels ? { lastQueryOfferHotels: { ...state.lastQueryOfferHotels } } : {}), ...(state.terminal ? { terminal: { ...state.terminal, hotelRefs: [...state.terminal.hotelRefs] } } : {}) }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> { return Boolean(value && typeof value === 'object' && !Array.isArray(value)) }
function isCriterion(value: unknown, valueCheck: (candidate: unknown) => boolean): boolean {
  return isPlainRecord(value) && Object.keys(value).length === 2 && (value.strength === 'must' || value.strength === 'prefer') && valueCheck(value.value)
}
function isMoney(value: unknown): boolean {
  return isPlainRecord(value) && Object.keys(value).length === 3 && typeof value.amount === 'string' && Boolean(value.amount) && typeof value.currency === 'string' && Boolean(value.currency) && typeof value.sourceFactRef === 'string' && Boolean(value.sourceFactRef)
}
function isOfferCriteria(value: unknown): value is OfferCriteria {
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
function bindCriteria(next: AvailabilityPolicyState, criteriaDigest: string, criteria?: OfferCriteria, required = false): void {
  if (criteria !== undefined) {
    if (!isOfferCriteria(criteria) || digest(criteria) !== criteriaDigest) throw new Error('availability_criteria_invalid')
    if (next.criteriaDigest !== undefined && next.criteriaDigest !== criteriaDigest) throw new Error('availability_criteria_changed')
    if (next.criteria && digest(next.criteria) !== criteriaDigest) throw new Error('availability_criteria_changed')
    next.criteria = structuredClone(criteria); next.criteriaDigest = criteriaDigest
  } else if (required && !next.criteria) throw new Error('availability_criteria_required')
  else if (next.criteria && next.criteriaDigest !== digest(next.criteria)) throw new Error('availability_criteria_mismatch')
  else if (!next.criteria && criteriaDigest) {
    if (next.criteriaDigest !== undefined && next.criteriaDigest !== criteriaDigest) throw new Error('availability_criteria_changed')
    next.criteriaDigest = criteriaDigest
  }
  if (next.criteriaDigest !== undefined && next.criteriaDigest !== criteriaDigest && criteriaDigest) throw new Error('availability_criteria_changed')
}
function terminalFor(state: AvailabilityPolicyState): AvailabilityExhaustion | undefined {
  if (!state.recoveryStarted || !state.hotelRefs.length) return undefined
  const hotels = state.hotelRefs.map((ref) => state.hotels[ref]!)
  if (hotels.some((hotel) => hotel.status === 'confirmed')) return { code: 'availability_confirmed', hotelRefs: [...state.hotelRefs], reason: 'confirmed', evidence: 'conclusive' }
  // A negative result is conclusive only when it has no legal refresh left.
  // The first manual check starts with a workspace generation (zero recovery
  // queries), so it must leave a fresh-query transition available.
  if (hotels.some((hotel) =>
    hotel.checksIssued < MAX_OFFER_CHECKS_PER_HOTEL
    && (
      hotel.status === 'active'
      || hotel.status === 'unvisited'
      || (hotel.freshOffersRequired && hotel.offerQueriesIssued < MAX_OFFER_QUERIES_PER_HOTEL)
    )
  )) return undefined
  const conclusive = hotels.every((hotel) => hotel.status === 'negative')
  return { code: conclusive ? 'availability_exhausted_complete' : 'availability_exhausted_inconclusive', hotelRefs: [...state.hotelRefs], reason: hotels.every((hotel) => !hotel.currentOfferRefs.length) ? 'no_current_offers' : 'check_limit_reached', evidence: conclusive ? 'conclusive' : 'inconclusive' }
}
function withTerminal(state: AvailabilityPolicyState): AvailabilityPolicyState { const terminal = terminalFor(state); return terminal ? { ...state, terminal, availabilityPhase: 'terminal' } : state }
function newHotel(hotelRef: string): AvailabilityHotelState { return { hotelRef, status: 'unvisited', checksIssued: 0, offerQueriesIssued: 0, generationNo: 0, generation: 0, currentOfferRefs: [], invalidatedOfferRefs: [], checkCount: 0, freshOffersRequired: false, tombstonedOfferRefs: [], tombstonedOfferVersionRefs: [], lastEvidence: 'none' } }
function phaseForActiveHotel(state: AvailabilityPolicyState): 'need_offers' | 'need_check' {
  const active = state.hotels[state.hotelRefs[state.activeHotelOrdinal] ?? '']
  return active?.status === 'active' && active.currentGeneration?.valid && active.currentOfferRefs.length > 0 && !active.freshOffersRequired
    ? 'need_check'
    : 'need_offers'
}

/** Initial workspace is only a hint; the bounded recovery starts at typed offers.query. */
export function createAvailabilityPolicy(workspace: BookingWorkspaceSnapshot): AvailabilityPolicyState { assertWorkspaceLoadedOfferRefsUnique(workspace); return { initialized: false, recoveryStarted: false, availabilityPhase: 'need_offers', activeHotelOrdinal: 0, hotelRefs: [], hotels: {}, attempts: [], queryReservations: [] } }
/** Ordinary search results never get silently truncated into recovery candidates. */
export function recordVisibleHotels(state: AvailabilityPolicyState, _workspace: BookingWorkspaceSnapshot): AvailabilityPolicyState { return copyState(state) }
/** Observe a normal offers query without opening an availability recovery. */
export function recordObservedOffersQuery(state: AvailabilityPolicyState, hotelRefs: readonly string[], criteriaDigest: string, workspace?: BookingWorkspaceSnapshot, receipt?: ActionReceipt, sourceActionId?: string, receiptDigest?: string, criteria?: OfferCriteria): AvailabilityPolicyState {
  if (workspace) assertWorkspaceLoadedOfferRefsUnique(workspace)
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
    if (!sourceActionId || sourceActionId !== receipt.actionId || !receiptDigest || receiptDigest !== digest(receipt)) throw new Error('availability_query_provenance_mismatch')
    next.lastQueryHotelRefs = [...new Set(hotelRefs)]
    next.lastQueryCriteriaDigest = criteriaDigest || undefined
    next.lastQueryOfferHotels = validateOffersReceiptWorkspace(receipt, workspace, hotelRefs)
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
export function validateOffersReceiptWorkspace(receipt: ActionReceipt, workspace: BookingWorkspaceSnapshot, hotelRefs: readonly string[]): Record<string, string> {
  assertWorkspaceLoadedOfferRefsUnique(workspace)
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
export function recordOffersQueryIssued(state: AvailabilityPolicyState, hotelRefs: readonly string[], workspace: BookingWorkspaceSnapshot, actionId: string, criteriaDigest = '', criteria?: OfferCriteria): AvailabilityPolicyState {
  assertWorkspaceLoadedOfferRefsUnique(workspace)
  const next = copyState(state); const requested = unique(hotelRefs)
  if (!requested.length || requested.length > MAX_HOTELS_PER_TASK) throw new Error('availability_hotel_limit_exceeded')
  if (!state.recoveryStarted) throw new Error('availability_recovery_not_started')
  if (state.terminal) {
    if (requested.some((ref) => state.hotels[ref]?.offerQueriesIssued >= MAX_OFFER_QUERIES_PER_HOTEL)) throw new Error('availability_offer_query_limit_reached')
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
  for (const hotelRef of requested) { const hotel = next.hotels[hotelRef]!; if (hotel.offerQueriesIssued >= MAX_OFFER_QUERIES_PER_HOTEL) throw new Error('availability_offer_query_limit_reached'); hotel.offerQueriesIssued += 1 }
  next.queryReservations.push({ actionId, hotelRefs: [...requested], workspaceRevision: workspace.revision }); next.availabilityPhase = 'waiting_offers'; next.initialized = true; return next
}
export function recordOffersGeneration(state: AvailabilityPolicyState, hotelRefs: readonly string[], workspace: BookingWorkspaceSnapshot, actionId: string, receiptDigest: string, receipt: ActionReceipt, criteriaDigest = '', criteria?: OfferCriteria): AvailabilityPolicyState {
  assertWorkspaceLoadedOfferRefsUnique(workspace)
  if (!state.recoveryStarted) return copyState(state)
  if (state.terminal) throw new Error('availability_terminal')
  const next = copyState(state); const requested = unique(hotelRefs)
  if (!requested.length || requested.length > MAX_HOTELS_PER_TASK) throw new Error('availability_hotel_limit_exceeded')
  const reservation = next.queryReservations.find((query) => query.actionId === actionId)
  if (!reservation || !sameSet(reservation.hotelRefs, requested)) throw new Error('availability_query_not_reserved')
  if (receipt.actionId !== actionId) throw new Error('availability_query_receipt_mismatch')
  if (receiptDigest !== digest(receipt)) throw new Error('availability_receipt_digest_mismatch')
  if (requested.some((ref) => !next.hotels[ref])) throw new Error('availability_hotel_unknown')
  else if ((requested.length !== 1 || next.hotelRefs[next.activeHotelOrdinal] !== requested[0]) && (next.attempts.length > 0 || Object.values(next.hotels).some((hotel) => hotel.generationNo > 0))) throw new Error('availability_hotel_not_active')
  bindCriteria(next, criteriaDigest, criteria)
  if (receipt.observation.kind === 'offers.state') validateOffersReceiptWorkspace(receipt, workspace, requested)
  for (const hotelRef of requested) {
    const hotel = next.hotels[hotelRef]!
    const partial = receipt.status === 'changed' || receipt.status === 'partial' || receipt.status === 'failed' || receipt.status === 'stale' || receipt.resultContract.outcome === 'partial' || (receipt.resultContract.outcome === 'complete' && !receipt.resultContract.hardCriteriaMet) || Boolean(receipt.resultContract.blockers.length) || Boolean(receipt.resultContract.gapCodes.length) || Boolean(receipt.observation.kind === 'gap' || (receipt.observation.kind === 'offers.state' && receipt.observation.gapCodes?.length))
    const candidateRefs = partial
      ? receipt.observation.kind === 'offers.state'
        ? receipt.observation.offerRefs.filter((ref) => workspace.loadedOffers.some((offer) => offer.offerRef === ref && offer.hotelRef === hotelRef))
        : []
      : offerRefsForHotel(workspace, hotelRef)
    const refs = legalOfferRefsForHotel(workspace, hotel, candidateRefs)
    const unusable = ['stale', 'failed', 'unsupported'].includes(receipt.status)
    if (unusable) { hotel.currentOfferRefs = []; hotel.invalidatedOfferRefs = [...(hotel.currentGeneration?.orderedOfferRefs ?? [])]; hotel.freshOffersRequired = hotel.checksIssued < MAX_OFFER_CHECKS_PER_HOTEL && hotel.offerQueriesIssued < MAX_OFFER_QUERIES_PER_HOTEL; hotel.status = 'inconclusive'; hotel.lastEvidence = 'inconclusive'; continue }
    const filteredAllCandidates = candidateRefs.length > 0 && refs.length === 0
    const noLegalRefsNeedsRefresh = filteredAllCandidates && hotel.offerQueriesIssued < MAX_OFFER_QUERIES_PER_HOTEL
    hotel.generationNo += 1; hotel.generation = hotel.generationNo; hotel.currentOfferRefs = partial || noLegalRefsNeedsRefresh ? [] : refs; hotel.invalidatedOfferRefs = partial || noLegalRefsNeedsRefresh ? candidateRefs : []; hotel.freshOffersRequired = (partial || noLegalRefsNeedsRefresh) && hotel.checksIssued < MAX_OFFER_CHECKS_PER_HOTEL && hotel.offerQueriesIssued < MAX_OFFER_QUERIES_PER_HOTEL; hotel.status = partial || noLegalRefsNeedsRefresh ? 'inconclusive' : refs.length ? 'active' : 'negative'; hotel.lastEvidence = partial || noLegalRefsNeedsRefresh ? 'inconclusive' : refs.length ? 'none' : 'unavailable'
    hotel.currentGeneration = { generationId: `${hotelRef}:generation:${hotel.generationNo}`, source: { kind: 'query_receipt', actionId, receiptDigest, workspaceRevision: workspace.revision }, offerSetDigest: digest(refs), orderedOfferRefs: refs, evidence: partial ? 'partial' : 'complete', valid: refs.length > 0 && !partial }
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

export function canIssueOfferCheck(state: AvailabilityPolicyState, workspace: BookingWorkspaceSnapshot, offerRef: string, offerVersionRef: string): AvailabilityPolicyDecision {
  assertWorkspaceLoadedOfferRefsUnique(workspace)
  // Availability recovery is opt-in at the typed offers.query seam. Existing
  // v2 read flows retain their pre-recovery offer.check behavior.
  if (!state.recoveryStarted) {
    const loaded = loadedOfferVersion(workspace, offerRef, offerVersionRef)
    return loaded
      ? { ok: true, hotelRef: loaded.hotelRef, offerRef, offerVersionRef, checkCount: 0, generation: 0 }
      : { ok: false, code: 'offer_not_loaded' }
  }
  if (state.terminal) return { ok: false, code: 'availability_exhausted' }
  const loaded = loadedOfferVersion(workspace, offerRef, offerVersionRef); if (!loaded) return { ok: false, code: 'offer_not_loaded' }
  const hotel = state.hotels[loaded.hotelRef]; if (!hotel) return { ok: false, code: 'hotel_unknown' }
  if (state.hotelRefs[state.activeHotelOrdinal] !== loaded.hotelRef) return { ok: false, code: 'hotel_not_active' }
  if (hotel.freshOffersRequired) return { ok: false, code: 'offers_refresh_required' }
  if (hotel.tombstonedOfferRefs.includes(offerRef) || hotel.tombstonedOfferVersionRefs.includes(offerVersionRef)) return { ok: false, code: 'generation_invalid' }
  if (!hotel.currentGeneration?.valid || !hotel.currentGeneration.orderedOfferRefs.includes(offerRef) || hotel.invalidatedOfferRefs.includes(offerRef)) return { ok: false, code: 'generation_invalid' }
  if (hotel.checksIssued >= MAX_OFFER_CHECKS_PER_HOTEL) return { ok: false, code: 'hotel_check_limit_reached' }
  return { ok: true, hotelRef: loaded.hotelRef, offerRef, offerVersionRef, checkCount: hotel.checksIssued + 1, generation: hotel.generationNo }
}
/** Start the bounded recovery epoch at the first typed offer.check. */
function startRecoveryAtOffer(state: AvailabilityPolicyState, workspace: BookingWorkspaceSnapshot, offerRef: string, actionId: string): AvailabilityPolicyState {
  assertWorkspaceLoadedOfferRefsUnique(workspace)
  const loaded = workspace.loadedOffers.find((offer) => offer.offerRef === offerRef)
  if (!loaded) return copyState(state)
  const shortlistHotels = workspace.shortlistedOfferRefs.map((ref) => workspace.loadedOffers.find((offer) => offer.offerRef === ref)?.hotelRef ?? state.lastQueryOfferHotels?.[ref]).map((ref, index) => {
    if (!ref) throw new Error(`availability_shortlist_unmapped:${workspace.shortlistedOfferRefs[index]}`)
    return ref
  })
  const fallbackHotels = shortlistHotels.length ? shortlistHotels : []
  const candidates = unique([loaded.hotelRef, ...fallbackHotels]).slice(0, MAX_HOTELS_PER_TASK)
  const next = copyState(state); next.recoveryStarted = true; next.recoveryId = `recovery:${actionId}`; next.hotelRefs = candidates; next.candidateSetDigest = digest(candidates); next.hotels = Object.fromEntries(candidates.map((ref) => [ref, newHotel(ref)]))
  const nextHotel = next.hotels[loaded.hotelRef]!
  const mappedRefs = state.lastQueryOfferHotels ? Object.entries(state.lastQueryOfferHotels).filter(([, hotel]) => hotel === loaded.hotelRef).map(([ref]) => ref) : []
  const currentRefs = unique(workspace.loadedOffers.filter((offer) => offer.hotelRef === loaded.hotelRef).map((offer) => offer.offerRef))
  const mapped = state.lastQueryOfferHotels?.[offerRef] === loaded.hotelRef
    && state.lastQueryWorkspaceRevision === workspace.revision
    && Boolean(state.lastQuerySourceActionId && state.lastQuerySourceReceiptDigest)
    && sameSet(mappedRefs, currentRefs)
  if (mapped && state.criteria) { next.criteria = structuredClone(state.criteria); next.criteriaDigest = digest(next.criteria) }
  const refs = mapped && state.lastQueryOfferHotels
    ? unique([offerRef, ...mappedRefs]).slice(0, MAX_OFFERS_PER_HOTEL_GENERATION)
    : offerRefsForHotel(workspace, loaded.hotelRef, offerRef)
  const source = mapped
    ? { kind: 'query_receipt' as const, actionId: state.lastQuerySourceActionId!, receiptDigest: state.lastQuerySourceReceiptDigest!, workspaceRevision: state.lastQueryWorkspaceRevision! }
    : { kind: 'workspace_snapshot' as const, workspaceDigest: workspaceDigest(workspace), workspaceRevision: workspace.revision }
  nextHotel.generationNo = 1; nextHotel.generation = 1; nextHotel.currentOfferRefs = refs; nextHotel.status = refs.length ? 'active' : 'inconclusive'; nextHotel.currentGeneration = { generationId: `${loaded.hotelRef}:generation:1`, source, offerSetDigest: digest(refs), orderedOfferRefs: refs, evidence: 'complete', valid: refs.length > 0 }; next.initialized = true; next.availabilityPhase = 'need_check'; return next
}
export function recordOfferCheckIssued(state: AvailabilityPolicyState, workspace: BookingWorkspaceSnapshot, offerRef: string, offerVersionRef: string, actionId = `offer-check-${offerRef}-${state.attempts.length + 1}`): AvailabilityPolicyState {
  assertWorkspaceLoadedOfferRefsUnique(workspace)
  if (state.terminal) throw new Error('availability_terminal')
  if (!state.recoveryStarted) {
    if (!loadedOfferVersion(workspace, offerRef, offerVersionRef)) throw new Error('availability_offer_not_loaded')
    const started = startRecoveryAtOffer(state, workspace, offerRef, actionId)
    return recordOfferCheckIssued(started, workspace, offerRef, offerVersionRef, actionId)
  }
  const decision = canIssueOfferCheck(state, workspace, offerRef, offerVersionRef); if (!decision.ok) throw new Error(`availability_${decision.code}`)
  const next = copyState(state); const hotel = next.hotels[decision.hotelRef]!; hotel.checksIssued += 1; hotel.checkCount = hotel.checksIssued; next.attempts.push({ actionId, hotelRef: decision.hotelRef, offerRef, offerVersionRef, generation: hotel.generationNo, ordinal: hotel.checksIssued, workspaceRevision: workspace.revision }); hotel.currentGeneration!.valid = false; next.availabilityPhase = 'waiting_check'; return next
}

/**
 * Fold the availability portion of an issued action.  Keeping this reducer
 * next to the receipt reducers makes ledger replay use precisely the same
 * transition as the write path.
 */
export function reduceAvailabilityAction(
  state: AvailabilityPolicyState,
  workspace: BookingWorkspaceSnapshot,
  action: AvailabilityActionLike,
): AvailabilityPolicyState {
  if (action.kind === 'offers.query') {
    if (!isOfferCriteria(action.input.criteria) && (!state.criteria || !isOfferCriteria(state.criteria))) throw new Error('availability_criteria_required')
    if (!isOfferCriteria(action.input.criteria) && state.recoveryStarted) throw new Error('availability_criteria_required')
    if (!isOfferCriteria(action.input.criteria)) throw new Error('availability_criteria_required')
    const criteriaDigest = digest(action.input.criteria)
    let next = recordObservedOffersQuery(state, action.input.hotelRefs, criteriaDigest)
    if (state.recoveryStarted) next = recordOffersQueryIssued(next, action.input.hotelRefs, workspace, action.actionId, criteriaDigest, action.input.criteria)
    return next
  }
  if (action.kind === 'offer.check') return recordOfferCheckIssued(state, workspace, action.input.offerRef, action.input.offerVersionRef, action.actionId)
  return copyState(state)
}

/** Fold a receipt against the exact durable attempt. Non-confirming results invalidate the whole generation. */
export function recordOfferCheckReceipt(state: AvailabilityPolicyState, workspace: BookingWorkspaceSnapshot, receipt: ActionReceipt, actionId: string, offerRef: string, offerVersionRef: string, expectedRevision: number): AvailabilityPolicyState {
  assertWorkspaceLoadedOfferRefsUnique(workspace)
  if (!state.recoveryStarted) return copyState(state)
  const attempt = state.attempts.find((candidate) => candidate.actionId === actionId); if (!attempt) throw new Error('availability_attempt_unknown')
  if (receipt.actionId !== actionId) throw new Error('availability_attempt_mismatch')
  if (receipt.revision !== workspace.revision || receipt.revision < expectedRevision) throw new Error('availability_stale_receipt')
  const targetOfferRef = receipt.observation.kind === 'offer.availability' ? receipt.observation.offerRef : offerRef
  const targetVersionRef = receipt.observation.kind === 'offer.availability' ? receipt.observation.checkedOfferVersionRef : offerVersionRef
  if (attempt.offerRef !== targetOfferRef || attempt.offerVersionRef !== targetVersionRef || offerRef !== targetOfferRef || offerVersionRef !== targetVersionRef || attempt.workspaceRevision !== expectedRevision) throw new Error('availability_attempt_mismatch')
  const next = copyState(state); const hotel = next.hotels[attempt.hotelRef]; if (!hotel || !hotel.currentGeneration || attempt.generation !== hotel.generationNo) throw new Error('availability_generation_mismatch')
  const observation = receipt.observation.kind === 'offer.availability' ? receipt.observation : undefined
  if (['applied', 'changed', 'unavailable', 'no_match'].includes(receipt.status) && !observation) throw new Error('availability_observation_required')
  if (observation?.available && (receipt.resultContract.outcome === 'empty' || ['unavailable', 'no_match', 'failed', 'stale', 'unsupported'].includes(receipt.status))) throw new Error('availability_receipt_incoherent')
  if (observation && !observation.available && (observation.verifiedOfferRef || observation.currentOfferVersionRef)) throw new Error('availability_receipt_incoherent')
  if (['unavailable', 'no_match'].includes(receipt.status) && receipt.resultContract.outcome !== 'empty') throw new Error('availability_receipt_incoherent')
  const confirmed = receipt.status === 'applied' && Boolean(observation?.available && observation.currentOfferVersionRef === offerVersionRef && observation.verifiedOfferRef && workspace.verifiedOffer?.offerRef === offerRef && workspace.verifiedOffer.offerVersionRef === offerVersionRef && workspace.verifiedOffer.verifiedOfferRef === observation.verifiedOfferRef && loadedOfferVersion(workspace, offerRef, offerVersionRef)) && !observation?.changedFactRefs.length && !observation?.gapCodes?.length && receipt.resultContract.outcome === 'complete' && receipt.resultContract.hardCriteriaMet && !receipt.resultContract.blockers.length && !receipt.resultContract.gapCodes.length
  if (confirmed) { hotel.status = 'confirmed'; hotel.lastEvidence = 'confirmed'; hotel.currentGeneration.valid = false; return withTerminal(next) }
  if (receipt.status === 'changed' && observation?.available && observation.currentOfferVersionRef && observation.currentOfferVersionRef !== offerVersionRef && observation.changedFactRefs.length && !observation.verifiedOfferRef && loadedOfferVersion(workspace, offerRef, observation.currentOfferVersionRef)) {
    hotel.tombstonedOfferVersionRefs = unique([...hotel.tombstonedOfferVersionRefs, offerVersionRef])
    hotel.currentGeneration.valid = true; hotel.invalidatedOfferRefs = []; hotel.currentOfferRefs = [offerRef]; hotel.freshOffersRequired = false; hotel.status = 'active'; hotel.lastEvidence = 'none'; next.availabilityPhase = 'need_check'; return withTerminal(next)
  }
  const completeNegative = (receipt.status === 'unavailable' || receipt.status === 'no_match') && receipt.resultContract.outcome === 'empty' && observation?.available === false && receipt.resultContract.gapCodes.length === 0 && !receipt.resultContract.blockers.length && !observation.gapCodes?.length
  if (completeNegative) {
    hotel.tombstonedOfferVersionRefs = unique([...hotel.tombstonedOfferVersionRefs, offerVersionRef])
    hotel.tombstonedOfferRefs = unique([...hotel.tombstonedOfferRefs, offerRef])
  }
  hotel.currentGeneration.valid = false; hotel.invalidatedOfferRefs = [...hotel.currentGeneration.orderedOfferRefs]; hotel.currentOfferRefs = []; hotel.freshOffersRequired = hotel.checksIssued < MAX_OFFER_CHECKS_PER_HOTEL && hotel.offerQueriesIssued < MAX_OFFER_QUERIES_PER_HOTEL
  hotel.status = completeNegative ? 'negative' : 'inconclusive'; hotel.lastEvidence = completeNegative ? 'unavailable' : 'inconclusive'
  const currentOrdinal = next.hotelRefs.indexOf(attempt.hotelRef)
  const nextOrdinal = hotel.freshOffersRequired ? currentOrdinal : next.hotelRefs.findIndex((ref) => ['active', 'unvisited'].includes(next.hotels[ref]!.status))
  if (nextOrdinal >= 0) next.activeHotelOrdinal = nextOrdinal
  next.availabilityPhase = phaseForActiveHotel(next); return withTerminal(next)
}

/** Fold the availability portion of a receipt using the same pure reducer as
 * continueWithReceipt and resumeTask. */
export function reduceAvailabilityReceipt(
  state: AvailabilityPolicyState,
  workspace: BookingWorkspaceSnapshot,
  receipt: ActionReceipt,
  action: AvailabilityActionLike,
): AvailabilityPolicyState {
  let next = recordVisibleHotels(state, workspace)
  if (action.kind === 'offers.query' && !state.recoveryStarted) {
    if (!isOfferCriteria(action.input.criteria)) throw new Error('availability_criteria_required')
    next = recordObservedOffersQuery(next, action.input.hotelRefs, digest(action.input.criteria), workspace, receipt, action.actionId, digest(receipt), action.input.criteria)
  } else if (action.kind === 'offers.query' && state.recoveryStarted) {
    if (!isOfferCriteria(action.input.criteria)) throw new Error('availability_criteria_required')
    next = recordOffersGeneration(next, action.input.hotelRefs, workspace, action.actionId, digest(receipt), receipt, state.criteriaDigest ?? '', action.input.criteria)
  } else if (action.kind === 'offer.check') {
    if (action.expectedRevision === undefined) throw new Error('availability_expected_revision_missing')
    next = recordOfferCheckReceipt(next, workspace, receipt, action.actionId, action.input.offerRef, action.input.offerVersionRef, action.expectedRevision)
  }
  return next
}
export function availabilityPolicyIsTerminal(state: AvailabilityPolicyState): boolean { return Boolean(state.terminal) }
export function availabilityPolicyResult(state: AvailabilityPolicyState): AvailabilityExhaustion | undefined { return state.terminal ? { ...state.terminal, hotelRefs: [...state.terminal.hotelRefs] } : undefined }
export function validateAvailabilityPolicy(state: AvailabilityPolicyState): boolean {
  try {
    if (!state || typeof state.initialized !== 'boolean' || typeof state.recoveryStarted !== 'boolean') return false
    if (state.recoveryId !== undefined && (typeof state.recoveryId !== 'string' || !state.recoveryId)) return false
    if (state.criteriaDigest !== undefined && (typeof state.criteriaDigest !== 'string' || !/^[0-9a-f]{64}$/.test(state.criteriaDigest))) return false
    if (state.candidateSetDigest !== undefined && (typeof state.candidateSetDigest !== 'string' || !/^[0-9a-f]{64}$/.test(state.candidateSetDigest))) return false
    if (!['need_offers', 'waiting_offers', 'need_check', 'waiting_check', 'terminal'].includes(state.availabilityPhase)) return false
    if (!Number.isSafeInteger(state.activeHotelOrdinal) || !Array.isArray(state.hotelRefs) || state.hotelRefs.length > MAX_HOTELS_PER_TASK) return false
    if (state.hotelRefs.some((ref) => typeof ref !== 'string' || !ref) || new Set(state.hotelRefs).size !== state.hotelRefs.length) return false
    if ((state.hotelRefs.length && (state.activeHotelOrdinal < 0 || state.activeHotelOrdinal >= state.hotelRefs.length)) || (!state.hotelRefs.length && state.activeHotelOrdinal !== 0)) return false
    if (!state.hotels || typeof state.hotels !== 'object' || Object.keys(state.hotels).sort().join('\0') !== [...state.hotelRefs].sort().join('\0')) return false
    if (!Array.isArray(state.attempts) || !Array.isArray(state.queryReservations)) return false
    if (!state.recoveryStarted) {
      if (state.recoveryId !== undefined || state.candidateSetDigest !== undefined || state.hotelRefs.length || Object.keys(state.hotels).length || state.attempts.length || state.queryReservations.length || state.terminal !== undefined) return false
    if (state.criteria !== undefined || state.criteriaDigest !== undefined) {
      if (!isOfferCriteria(state.criteria) || !state.criteriaDigest || state.criteriaDigest !== digest(state.criteria)) return false
    }
    if (state.lastQueryCriteriaDigest !== undefined && state.lastQueryCriteriaDigest !== state.criteriaDigest) return false
    if (state.lastQueryHotelRefs !== undefined && (!Array.isArray(state.lastQueryHotelRefs) || new Set(state.lastQueryHotelRefs).size !== state.lastQueryHotelRefs.length || state.lastQueryHotelRefs.some((ref) => typeof ref !== 'string' || !ref))) return false
    if (state.lastQueryOfferHotels !== undefined && (!state.lastQueryHotelRefs || Object.values(state.lastQueryOfferHotels).some((ref) => typeof ref !== 'string' || !state.lastQueryHotelRefs!.includes(ref)) || Object.keys(state.lastQueryOfferHotels).some((ref) => typeof ref !== 'string' || !ref))) return false
    if (state.lastQuerySourceActionId !== undefined && (typeof state.lastQuerySourceActionId !== 'string' || !state.lastQuerySourceActionId || typeof state.lastQuerySourceReceiptDigest !== 'string' || !/^[0-9a-f]{64}$/.test(state.lastQuerySourceReceiptDigest) || !Number.isSafeInteger(state.lastQueryWorkspaceRevision) || state.lastQueryWorkspaceRevision! < 0)) return false
    if (state.lastQuerySourceReceiptDigest !== undefined && state.lastQuerySourceActionId === undefined) return false
    return state.initialized === false && state.availabilityPhase === 'need_offers'
    }
    if (!state.initialized || !state.recoveryId || !state.candidateSetDigest || state.candidateSetDigest !== digest(state.hotelRefs)) return false
    const criteriaBound = isOfferCriteria(state.criteria) && Boolean(state.criteriaDigest) && state.criteriaDigest === digest(state.criteria)
    const manualCheckWorkspaceSnapshot = state.attempts.length > 0 && state.attempts.every((attempt) => state.hotels[attempt.hotelRef]?.currentGeneration?.source.kind === 'workspace_snapshot')
    const manualCheckMayBindCriteria = !state.criteria && !state.criteriaDigest && state.queryReservations.length === 0 && manualCheckWorkspaceSnapshot && (
      ['waiting_check', 'need_offers'].includes(state.availabilityPhase)
      || state.availabilityPhase === 'need_check'
      || (state.availabilityPhase === 'terminal' && state.terminal?.code === 'availability_confirmed')
    )
    if (!criteriaBound && !manualCheckMayBindCriteria) return false
    if (state.lastQueryCriteriaDigest !== undefined && state.lastQueryCriteriaDigest !== state.criteriaDigest) return false
    if (state.lastQueryHotelRefs !== undefined && (!Array.isArray(state.lastQueryHotelRefs) || new Set(state.lastQueryHotelRefs).size !== state.lastQueryHotelRefs.length || state.lastQueryHotelRefs.some((ref) => typeof ref !== 'string' || !ref))) return false
    if (state.lastQueryOfferHotels !== undefined && (!state.lastQueryHotelRefs || Object.values(state.lastQueryOfferHotels).some((ref) => typeof ref !== 'string' || !state.lastQueryHotelRefs!.includes(ref)) || Object.keys(state.lastQueryOfferHotels).some((ref) => typeof ref !== 'string' || !ref))) return false
    if (state.lastQuerySourceActionId !== undefined && (typeof state.lastQuerySourceActionId !== 'string' || !state.lastQuerySourceActionId || typeof state.lastQuerySourceReceiptDigest !== 'string' || !/^[0-9a-f]{64}$/.test(state.lastQuerySourceReceiptDigest) || !Number.isSafeInteger(state.lastQueryWorkspaceRevision) || state.lastQueryWorkspaceRevision! < 0)) return false
    if (state.lastQuerySourceReceiptDigest !== undefined && state.lastQuerySourceActionId === undefined) return false
    if (state.hotelRefs.length === 0) return false
    const validStatus = new Set<AvailabilityHotelStatus>(['unvisited', 'active', 'negative', 'confirmed', 'inconclusive'])
    const validEvidence = new Set<AvailabilityHotelState['lastEvidence']>(['none', 'confirmed', 'unavailable', 'inconclusive'])
    for (const ref of state.hotelRefs) {
      const hotel = state.hotels[ref]
      if (!hotel || hotel.hotelRef !== ref || !validStatus.has(hotel.status) || !validEvidence.has(hotel.lastEvidence)) return false
      if (![hotel.checksIssued, hotel.offerQueriesIssued, hotel.generationNo, hotel.generation, hotel.checkCount].every(Number.isSafeInteger)) return false
      if (hotel.checksIssued < 0 || hotel.checksIssued > MAX_OFFER_CHECKS_PER_HOTEL || hotel.offerQueriesIssued < 0 || hotel.offerQueriesIssued > MAX_OFFER_QUERIES_PER_HOTEL || hotel.generationNo < 0 || hotel.generation !== hotel.generationNo || hotel.checkCount !== hotel.checksIssued) return false
      if (typeof hotel.freshOffersRequired !== 'boolean' || !Array.isArray(hotel.currentOfferRefs) || !Array.isArray(hotel.invalidatedOfferRefs) || !Array.isArray(hotel.tombstonedOfferRefs) || !Array.isArray(hotel.tombstonedOfferVersionRefs)) return false
      if (hotel.currentOfferRefs.some((offer) => typeof offer !== 'string' || !offer) || hotel.invalidatedOfferRefs.some((offer) => typeof offer !== 'string' || !offer) || hotel.tombstonedOfferRefs.some((offer) => typeof offer !== 'string' || !offer) || hotel.tombstonedOfferVersionRefs.some((offer) => typeof offer !== 'string' || !offer)) return false
      if (new Set(hotel.currentOfferRefs).size !== hotel.currentOfferRefs.length || new Set(hotel.invalidatedOfferRefs).size !== hotel.invalidatedOfferRefs.length || new Set(hotel.tombstonedOfferRefs).size !== hotel.tombstonedOfferRefs.length || new Set(hotel.tombstonedOfferVersionRefs).size !== hotel.tombstonedOfferVersionRefs.length || hotel.currentOfferRefs.length > MAX_OFFERS_PER_HOTEL_GENERATION || hotel.invalidatedOfferRefs.length > MAX_OFFERS_PER_HOTEL_GENERATION || hotel.currentOfferRefs.some((offer) => hotel.invalidatedOfferRefs.includes(offer) || hotel.tombstonedOfferRefs.includes(offer))) return false
      const generation = hotel.currentGeneration
      if (hotel.generationNo === 0) {
        if (generation !== undefined || hotel.currentOfferRefs.length || hotel.invalidatedOfferRefs.length || hotel.tombstonedOfferRefs.length || hotel.tombstonedOfferVersionRefs.length || hotel.status !== 'unvisited' || hotel.lastEvidence !== 'none' || hotel.checksIssued !== 0 || hotel.offerQueriesIssued !== 0 || hotel.freshOffersRequired) return false
        continue
      }
      if (!generation || generation.generationId !== `${ref}:generation:${hotel.generationNo}` || !/^[0-9a-f]{64}$/.test(generation.offerSetDigest) || generation.offerSetDigest !== digest(generation.orderedOfferRefs) || !Array.isArray(generation.orderedOfferRefs) || generation.orderedOfferRefs.length > MAX_OFFERS_PER_HOTEL_GENERATION || generation.orderedOfferRefs.some((offer) => typeof offer !== 'string' || !offer) || new Set(generation.orderedOfferRefs).size !== generation.orderedOfferRefs.length || !['complete', 'partial'].includes(generation.evidence) || typeof generation.valid !== 'boolean') return false
      if (generation.offerSetDigest !== digest(generation.orderedOfferRefs) || hotel.currentOfferRefs.some((offer) => !generation.orderedOfferRefs.includes(offer)) || hotel.invalidatedOfferRefs.some((offer) => !generation.orderedOfferRefs.includes(offer))) return false
      const source = generation.source
      if (!source || !['query_receipt', 'workspace_snapshot'].includes(source.kind) || !Number.isSafeInteger(source.workspaceRevision) || source.workspaceRevision < 0) return false
      if (source.kind === 'query_receipt' && (typeof source.actionId !== 'string' || !source.actionId || !/^[0-9a-f]{64}$/.test(source.receiptDigest))) return false
      if (source.kind === 'workspace_snapshot' && (typeof source.workspaceDigest !== 'string' || !/^[0-9a-f]{64}$/.test(source.workspaceDigest))) return false
      if (source.kind === 'query_receipt' && state.lastQuerySourceActionId === source.actionId && (state.lastQuerySourceReceiptDigest !== source.receiptDigest || state.lastQueryWorkspaceRevision !== source.workspaceRevision)) return false
      if (hotel.freshOffersRequired && (hotel.currentOfferRefs.length !== 0 || hotel.checksIssued >= MAX_OFFER_CHECKS_PER_HOTEL || hotel.offerQueriesIssued >= MAX_OFFER_QUERIES_PER_HOTEL)) return false
      if (hotel.status === 'unvisited' || hotel.status === 'negative') {
        if (hotel.status === 'unvisited' || hotel.lastEvidence !== 'unavailable' || hotel.currentOfferRefs.length || generation.valid) return false
      }
      if (hotel.status === 'active' && (!hotel.currentOfferRefs.length || hotel.lastEvidence !== 'none' || hotel.freshOffersRequired)) return false
      if (hotel.status === 'confirmed' && (hotel.lastEvidence !== 'confirmed' || !hotel.currentOfferRefs.length || generation.valid)) return false
      if (hotel.status === 'inconclusive' && (hotel.lastEvidence !== 'inconclusive' || hotel.currentOfferRefs.length || generation.valid)) return false
    }
    const attempts = state.attempts
    if (new Set(attempts.map((attempt) => attempt.actionId)).size !== attempts.length) return false
    const attemptsByHotel = new Map<string, AvailabilityAttempt[]>()
    for (const attempt of attempts) {
      if (typeof attempt.actionId !== 'string' || !attempt.actionId || !state.hotels[attempt.hotelRef] || typeof attempt.offerRef !== 'string' || !attempt.offerRef || typeof attempt.offerVersionRef !== 'string' || !attempt.offerVersionRef || !Number.isSafeInteger(attempt.generation) || !Number.isSafeInteger(attempt.ordinal) || !Number.isSafeInteger(attempt.workspaceRevision) || attempt.workspaceRevision < 0) return false
      const hotel = state.hotels[attempt.hotelRef]!
      const generation = hotel.currentGeneration
      if (!generation || attempt.generation < 1 || attempt.generation > hotel.generationNo || attempt.ordinal < 1 || attempt.ordinal > hotel.checksIssued || (attempt.generation === hotel.generationNo && !generation.orderedOfferRefs.includes(attempt.offerRef))) return false
      const list = attemptsByHotel.get(attempt.hotelRef) ?? []; list.push(attempt); attemptsByHotel.set(attempt.hotelRef, list)
    }
    for (const [ref, attemptsForHotel] of attemptsByHotel) {
      const ordinals = attemptsForHotel.map((attempt) => attempt.ordinal)
      if (new Set(ordinals).size !== ordinals.length || attemptsForHotel.length !== state.hotels[ref]!.checksIssued || new Set(attemptsForHotel.map((attempt) => `${attempt.generation}:${attempt.offerRef}:${attempt.offerVersionRef}`)).size !== attemptsForHotel.length) return false
    }
    for (const ref of state.hotelRefs) if ((attemptsByHotel.get(ref)?.length ?? 0) !== state.hotels[ref]!.checksIssued) return false
    if (new Set(state.queryReservations.map((reservation) => reservation.actionId)).size !== state.queryReservations.length) return false
    const reservedHotels = new Set<string>()
    for (const reservation of state.queryReservations) {
      if (typeof reservation.actionId !== 'string' || !reservation.actionId || !Array.isArray(reservation.hotelRefs) || !reservation.hotelRefs.length || reservation.hotelRefs.length > MAX_HOTELS_PER_TASK || new Set(reservation.hotelRefs).size !== reservation.hotelRefs.length || reservation.hotelRefs.some((ref) => !state.hotels[ref]) || !Number.isSafeInteger(reservation.workspaceRevision) || reservation.workspaceRevision < 0 || reservation.hotelRefs.some((ref) => reservedHotels.has(ref))) return false
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
      if (!recomputedTerminal || digest(state.terminal) !== digest(recomputedTerminal)) return false
    } else if (recomputedTerminal && !['waiting_offers', 'waiting_check'].includes(state.availabilityPhase)) return false
    return true
  } catch {
    return false
  }
}
export function availabilityPolicyActionIsRelevant(action: BookingReadAction): boolean { return action.kind === 'offers.query' || action.kind === 'offer.check' }
