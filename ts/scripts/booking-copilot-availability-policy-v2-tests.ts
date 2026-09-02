import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensureLedger } from '../src/state-ledger.ts'
import { BookingCopilotTaskRuntimeV2 } from '../src/booking-surface/runtime-v2.ts'
import { createAvailabilityPolicyV2, digestV2, MAX_HOTELS_PER_TASK_V2, MAX_OFFER_CHECKS_PER_HOTEL_V2, MAX_OFFER_QUERIES_PER_HOTEL_V2, recordObservedOffersQueryV2, recordOfferCheckIssuedV2, recordOfferCheckReceiptV2, recordOffersGenerationV2, recordOffersQueryIssuedV2, canIssueOfferCheckV2, type AvailabilityPolicyStateV2 } from '../src/booking-surface/availability-policy-v2.ts'
import { bookingSurfaceAllowedActionsV2 } from '../src/booking-surface/contracts-v2.ts'
import type { ActionReceiptV2, BookingReadActionKindV2, BookingSurfaceEventV2, BookingWorkspaceSnapshotV2, VerifiedOfferCapabilityV2 } from '../src/booking-surface/contracts-v2.ts'
import type { OfferCriteriaV1 } from '../src/booking-surface/contracts.ts'
const versionFor=(offerRef:string, suffix='v1'):string=>`${offerRef}:${suffix}`
const verifiedCapability=(offerRef:string,offerVersionRef=versionFor(offerRef),expiresAt='2026-09-01T10:30:00.000Z'):VerifiedOfferCapabilityV2=>({offerRef,offerVersionRef,verifiedOfferRef:`verified-${offerRef}`,expiresAt})
const ws=(revision:number,hotels:string[],offers:Array<[string,string,string?]>,shortlistedOfferRefs:string[]=[],verifiedOffer?:VerifiedOfferCapabilityV2):BookingWorkspaceSnapshotV2=>({schemaVersion:'booking.surface.v2',contextRef:'ctx-availability',surface:'tenant',revision,locale:'en-US',currency:'AED',searchDraft:{},results:{status:'idle'},visibleHotels:hotels.map(h=>({hotelRef:h,name:h,factRefs:[]})),loadedOffers:offers.map(([offerRef,hotelRef,offerVersionRef=versionFor(offerRef)])=>({offerRef,offerVersionRef,hotelRef,evidenceLevel:'rate_loaded',factRefs:[]})),shortlistedOfferRefs,capabilities:{surface:'tenant',allowedActions:['offers.query','offer.check'] as BookingReadActionKindV2[]},...(verifiedOffer ? {verifiedOffer} : {})})
const receipt=(actionId:string,revision:number,offerRef:string,status:ActionReceiptV2['status']='unavailable',available=false,checkedOfferVersionRef=versionFor(offerRef),currentOfferVersionRef?:string):ActionReceiptV2=>({schemaVersion:'booking.surface.v2',kind:'action.receipt',actionId,contextRef:'ctx-availability',status,revision,observation:{kind:'offer.availability',offerRef,checkedOfferVersionRef,currentOfferVersionRef:available?(currentOfferVersionRef ?? checkedOfferVersionRef):undefined,available,verifiedOfferRef:available?'verified-'+offerRef:undefined,changedFactRefs:[],gapCodes:[]},resultContract:{outcome:available?'complete':'empty',hardCriteriaMet:available,factRefs:[],gapCodes:[],blockers:[],relaxationsApplied:[]}})
const foldQuery = (state: AvailabilityPolicyStateV2, hotelRefs: string[], workspace: BookingWorkspaceSnapshotV2, actionId: string, queryReceipt: ActionReceiptV2, criteriaDigest = '') => recordOffersGenerationV2(state, hotelRefs, workspace, actionId, digestV2(queryReceipt), queryReceipt, criteriaDigest)
const criteria: OfferCriteriaV1 = {}
const offersReceipt=(actionId:string,revision:number,hotelRefs:string[],offerRefs:string[],loadedHotelCount:number,status:ActionReceiptV2['status']='applied',outcome:'complete'|'partial'|'empty'='complete',hardCriteriaMet=true):ActionReceiptV2=>({schemaVersion:'booking.surface.v2',kind:'action.receipt',actionId,contextRef:'ctx-availability',status,revision,observation:{kind:'offers.state',hotelRefs,offerRefs,loadedHotelCount,gapCodes:[]},resultContract:{outcome,hardCriteriaMet,factRefs:[],gapCodes:[],blockers:[],relaxationsApplied:[]}})
const gapReceipt=(actionId:string,revision:number,status:ActionReceiptV2['status']='failed'):ActionReceiptV2=>({schemaVersion:'booking.surface.v2',kind:'action.receipt',actionId,contextRef:'ctx-availability',status,revision,observation:{kind:'gap',code:'hotel_rates_failed',factRefs:[]},resultContract:{outcome:'partial',hardCriteriaMet:false,factRefs:[],gapCodes:['hotel_rates_failed'],blockers:[],relaxationsApplied:[]}})

// UAT-facing product availability observation: these are exact least-privilege
// sets, and are intentionally separate from the full tenant action vocabulary.
assert.deepEqual(bookingSurfaceAllowedActionsV2('storefront'), ['search.patch', 'search.run', 'results.view.patch', 'hotel.focus'])
assert.deepEqual(bookingSurfaceAllowedActionsV2('payment_link'), ['search.patch', 'search.run', 'results.view.patch', 'hotel.focus', 'hotel.select'])

// Lifetime budget mutation guard: these assertions exercise the transitions,
// not just the exported constants, so changing a comparison or reset policy
// makes this proof fail.
{
  assert.equal(MAX_HOTELS_PER_TASK_V2, 5)
  assert.equal(MAX_OFFER_CHECKS_PER_HOTEL_V2, 2)
  assert.equal(MAX_OFFER_QUERIES_PER_HOTEL_V2, 2)

  const unavailableWorkspace = ws(0, ['budget-hotel'], [['budget-hotel:ratepkg-1', 'budget-hotel']])
  let exhausted = recordOfferCheckIssuedV2(createAvailabilityPolicyV2(unavailableWorkspace), unavailableWorkspace, 'budget-hotel:ratepkg-1', versionFor('budget-hotel:ratepkg-1'), 'budget-check-1')
  exhausted = recordOfferCheckReceiptV2(exhausted, ws(1, ['budget-hotel'], [['budget-hotel:ratepkg-1', 'budget-hotel']]), receipt('budget-check-1', 1, 'budget-hotel:ratepkg-1'), 'budget-check-1', 'budget-hotel:ratepkg-1', versionFor('budget-hotel:ratepkg-1'), 0)
  assert.equal(exhausted.hotels['budget-hotel']?.freshOffersRequired, true, 'first unavailable opens exactly one fresh-generation transition')

  exhausted = recordOffersQueryIssuedV2(exhausted, ['budget-hotel'], ws(1, ['budget-hotel'], [['budget-hotel:ratepkg-1', 'budget-hotel']]), 'budget-query-1')
  const reusedReceipt = offersReceipt('budget-query-1', 2, ['budget-hotel'], ['budget-hotel:ratepkg-1'], 1)
  const reused = recordOffersGenerationV2(exhausted, ['budget-hotel'], ws(2, ['budget-hotel'], [['budget-hotel:ratepkg-1', 'budget-hotel']]), 'budget-query-1', digestV2(reusedReceipt), reusedReceipt)
  assert.deepEqual(reused.hotels['budget-hotel']?.currentOfferRefs, [], 'fresh HotelRates cannot re-admit the checked stale OfferRef')
  assert.equal(reused.hotels['budget-hotel']?.freshOffersRequired, true, 'stale OfferRef reuse leaves an explicit refresh transition')
  const refreshedReceipt = offersReceipt('budget-query-1', 2, ['budget-hotel'], ['budget-hotel:ratepkg-2'], 1)
  exhausted = recordOffersGenerationV2(exhausted, ['budget-hotel'], ws(2, ['budget-hotel'], [['budget-hotel:ratepkg-2', 'budget-hotel']]), 'budget-query-1', digestV2(refreshedReceipt), refreshedReceipt)
  exhausted = recordOfferCheckIssuedV2(exhausted, ws(2, ['budget-hotel'], [['budget-hotel:ratepkg-2', 'budget-hotel']]), 'budget-hotel:ratepkg-2', versionFor('budget-hotel:ratepkg-2'), 'budget-check-2')
  exhausted = recordOfferCheckReceiptV2(exhausted, ws(3, ['budget-hotel'], [['budget-hotel:ratepkg-2', 'budget-hotel']]), receipt('budget-check-2', 3, 'budget-hotel:ratepkg-2'), 'budget-check-2', 'budget-hotel:ratepkg-2', versionFor('budget-hotel:ratepkg-2'), 2)
  assert.equal(exhausted.hotels['budget-hotel']?.checksIssued, 2, 'second unavailable consumes the lifetime CheckAvail budget')
  assert.equal(exhausted.terminal?.code, 'availability_exhausted_complete', 'second unavailable reaches conclusive exhaustion')
  assert.throws(() => recordOfferCheckIssuedV2(exhausted, ws(3, ['budget-hotel'], [['budget-hotel:ratepkg-1', 'budget-hotel']]), 'budget-hotel:ratepkg-1', versionFor('budget-hotel:ratepkg-1'), 'budget-check-3'), /availability_terminal/, 'third CheckAvail cannot be issued after terminal exhaustion')

  const unavailableWithGap = (actionId: string, revision: number): ActionReceiptV2 => ({
    ...receipt(actionId, revision, 'budget-hotel:ratepkg-1'),
    observation: { kind: 'offer.availability', offerRef: 'budget-hotel:ratepkg-1', checkedOfferVersionRef: versionFor('budget-hotel:ratepkg-1'), available: false, changedFactRefs: [], gapCodes: ['hotel_rates_failed'] },
    resultContract: { outcome: 'empty', hardCriteriaMet: false, factRefs: [], gapCodes: ['hotel_rates_failed'], blockers: [], relaxationsApplied: [] },
  })
  let inconclusive = recordOfferCheckIssuedV2(createAvailabilityPolicyV2(unavailableWorkspace), unavailableWorkspace, 'budget-hotel:ratepkg-1', versionFor('budget-hotel:ratepkg-1'), 'gap-check-1')
  inconclusive = recordOfferCheckReceiptV2(inconclusive, ws(1, ['budget-hotel'], [['budget-hotel:ratepkg-1', 'budget-hotel']]), unavailableWithGap('gap-check-1', 1), 'gap-check-1', 'budget-hotel:ratepkg-1', versionFor('budget-hotel:ratepkg-1'), 0)
  assert.equal(inconclusive.hotels['budget-hotel']?.status, 'inconclusive', 'generic gap is not accepted as a typed negative')
  assert.equal(inconclusive.hotels['budget-hotel']?.tombstonedOfferRefs.includes('budget-hotel:ratepkg-1'), false, 'generic gap cannot tombstone logical offer')
  assert.equal(inconclusive.hotels['budget-hotel']?.tombstonedOfferVersionRefs.includes(versionFor('budget-hotel:ratepkg-1')), false, 'generic gap cannot tombstone offer version')
  inconclusive = recordOffersQueryIssuedV2(inconclusive, ['budget-hotel'], ws(1, ['budget-hotel'], [['budget-hotel:ratepkg-1', 'budget-hotel']]), 'gap-query-1')
  const gapRefreshedReceipt = offersReceipt('gap-query-1', 2, ['budget-hotel'], ['budget-hotel:ratepkg-3'], 1)
  inconclusive = recordOffersGenerationV2(inconclusive, ['budget-hotel'], ws(2, ['budget-hotel'], [['budget-hotel:ratepkg-3', 'budget-hotel']]), 'gap-query-1', digestV2(gapRefreshedReceipt), gapRefreshedReceipt)
  inconclusive = recordOfferCheckIssuedV2(inconclusive, ws(2, ['budget-hotel'], [['budget-hotel:ratepkg-3', 'budget-hotel']]), 'budget-hotel:ratepkg-3', versionFor('budget-hotel:ratepkg-3'), 'gap-check-2')
  inconclusive = recordOfferCheckReceiptV2(inconclusive, ws(3, ['budget-hotel'], [['budget-hotel:ratepkg-3', 'budget-hotel']]), { ...unavailableWithGap('gap-check-2', 3), observation: { kind: 'offer.availability', offerRef: 'budget-hotel:ratepkg-3', checkedOfferVersionRef: versionFor('budget-hotel:ratepkg-3'), available: false, changedFactRefs: [], gapCodes: [] } }, 'gap-check-2', 'budget-hotel:ratepkg-3', versionFor('budget-hotel:ratepkg-3'), 2)
  assert.equal(inconclusive.terminal?.code, 'availability_exhausted_inconclusive', 'an unavailable receipt with a gap never masquerades as conclusive exhaustion')

  for (const status of ['unavailable', 'no_match'] as const) {
    const gapAction = `generic-gap-${status}`
    const gapState = recordOfferCheckIssuedV2(createAvailabilityPolicyV2(unavailableWorkspace), unavailableWorkspace, 'budget-hotel:ratepkg-1', versionFor('budget-hotel:ratepkg-1'), gapAction)
    const gap = { ...receipt(gapAction, 1, 'budget-hotel:ratepkg-1', status), observation: { kind: 'offer.availability' as const, offerRef: 'budget-hotel:ratepkg-1', checkedOfferVersionRef: versionFor('budget-hotel:ratepkg-1'), available: false, changedFactRefs: [], gapCodes: ['hotel_rates_failed' as const] }, resultContract: { outcome: 'empty' as const, hardCriteriaMet: false, factRefs: [], gapCodes: ['hotel_rates_failed' as const], blockers: [], relaxationsApplied: [] } }
    const afterGap = recordOfferCheckReceiptV2(gapState, ws(1, ['budget-hotel'], [['budget-hotel:ratepkg-1', 'budget-hotel']]), gap, gapAction, 'budget-hotel:ratepkg-1', versionFor('budget-hotel:ratepkg-1'), 0)
    assert.equal(afterGap.hotels['budget-hotel']?.status, 'inconclusive', `${status} with generic gap remains inconclusive`)
    assert.equal(afterGap.hotels['budget-hotel']?.tombstonedOfferRefs.includes('budget-hotel:ratepkg-1'), false, `${status} with generic gap cannot tombstone logical offer`)
    assert.equal(afterGap.hotels['budget-hotel']?.tombstonedOfferVersionRefs.includes(versionFor('budget-hotel:ratepkg-1')), false, `${status} with generic gap cannot tombstone version`)
  }

  let queryBudget = recordOfferCheckIssuedV2(createAvailabilityPolicyV2(unavailableWorkspace), unavailableWorkspace, 'budget-hotel:ratepkg-1', versionFor('budget-hotel:ratepkg-1'), 'query-budget-check')
  queryBudget = recordOfferCheckReceiptV2(queryBudget, ws(1, ['budget-hotel'], [['budget-hotel:ratepkg-1', 'budget-hotel']]), receipt('query-budget-check', 1, 'budget-hotel:ratepkg-1'), 'query-budget-check', 'budget-hotel:ratepkg-1', versionFor('budget-hotel:ratepkg-1'), 0)
  for (const [actionId, revision] of [['query-budget-1', 2], ['query-budget-2', 3] ] as const) {
    const offerRef = `budget-hotel:query-ratepkg-${revision}`
    queryBudget = recordOffersQueryIssuedV2(queryBudget, ['budget-hotel'], ws(revision - 1, ['budget-hotel'], [[offerRef, 'budget-hotel']]), actionId)
    const queryReceipt = offersReceipt(actionId, revision, ['budget-hotel'], [offerRef], 1)
    queryBudget = recordOffersGenerationV2(queryBudget, ['budget-hotel'], ws(revision, ['budget-hotel'], [[offerRef, 'budget-hotel']]), actionId, digestV2(queryReceipt), queryReceipt)
  }
  assert.equal(queryBudget.hotels['budget-hotel']?.offerQueriesIssued, 2, 'two refresh queries are retained as lifetime usage')
  assert.throws(() => recordOffersQueryIssuedV2(queryBudget, ['budget-hotel'], ws(3, ['budget-hotel'], [['budget-hotel:ratepkg-1', 'budget-hotel']]), 'query-budget-3'), /availability_offer_query_limit_reached/, 'third offers.query is rejected')

  const hotels = ['h1', 'h2', 'h3', 'h4', 'h5', 'h6']
  const candidateWorkspace = ws(0, hotels, hotels.map((hotelRef, index) => [`candidate-${index + 1}`, hotelRef]), ['candidate-6', 'candidate-1', 'candidate-2', 'candidate-3', 'candidate-4', 'candidate-5'])
  const candidates = recordOfferCheckIssuedV2(createAvailabilityPolicyV2(candidateWorkspace), candidateWorkspace, 'candidate-6', versionFor('candidate-6'), 'candidate-check')
  assert.deepEqual(candidates.hotelRefs, ['h6', 'h1', 'h2', 'h3', 'h4'], 'selected hotel is first and recovery freezes at five candidates')
  assert.equal(candidates.hotelRefs.includes('h5'), false, 'sixth shortlisted hotel never enters the recovery epoch')

  const duplicateWorkspace = ws(0, ['dup-a', 'dup-b'], [['dup-offer', 'dup-a'], ['dup-offer', 'dup-b']])
  assert.throws(() => createAvailabilityPolicyV2(duplicateWorkspace), /availability_duplicate_offer_ref/, 'loaded OfferRef must be globally unique before any .find-based authority lookup')
  assert.throws(() => canIssueOfferCheckV2(createAvailabilityPolicyV2(ws(0, ['dup-a'], [])), duplicateWorkspace, 'dup-offer', versionFor('dup-offer')), /availability_duplicate_offer_ref/)
}

// Locked cap and source cases: a selected RoomList offer wins ordering, while
// a complete recovery generation never admits more than three offers.
{
  const roomList = ws(0, ['room-hotel'], [['room-1', 'room-hotel'], ['room-2', 'room-hotel'], ['room-3', 'room-hotel'], ['room-4', 'room-hotel']], ['room-4'])
  const selected = recordOfferCheckIssuedV2(createAvailabilityPolicyV2(roomList), roomList, 'room-4', versionFor('room-4'), 'room-check')
  assert.deepEqual(selected.hotels['room-hotel']?.currentOfferRefs, ['room-4', 'room-1', 'room-2'])
  assert.equal(selected.hotels['room-hotel']?.currentGeneration?.source.kind, 'workspace_snapshot')

  const complete = ws(0, ['complete-hotel'], [['complete-1', 'complete-hotel']])
  const completeStarted = recordOfferCheckIssuedV2(createAvailabilityPolicyV2(complete), complete, 'complete-1', versionFor('complete-1'), 'complete-check')
  const completeQuery = recordOffersQueryIssuedV2(completeStarted, ['complete-hotel'], complete, 'complete-query', digestV2(criteria), criteria)
  const fourOfferWorkspace = ws(1, ['complete-hotel'], [['complete-1', 'complete-hotel'], ['complete-2', 'complete-hotel'], ['complete-3', 'complete-hotel'], ['complete-4', 'complete-hotel']])
  assert.throws(() => recordOffersGenerationV2(completeQuery, ['complete-hotel'], fourOfferWorkspace, 'complete-query', digestV2(offersReceipt('complete-query', 1, ['complete-hotel'], ['complete-1', 'complete-2', 'complete-3', 'complete-4'], 1)), offersReceipt('complete-query', 1, ['complete-hotel'], ['complete-1', 'complete-2', 'complete-3', 'complete-4'], 1), digestV2(criteria), criteria), /availability_offer_limit_exceeded/)
}

// Locked partial/empty reconciliation: a partial receipt may only project an
// evidenced subset, and a clean empty receipt must agree with workspace truth.
{
  const partialWorkspace = ws(0, ['partial-hotel'], [['partial-1', 'partial-hotel'], ['partial-2', 'partial-hotel'], ['partial-3', 'partial-hotel']])
  const partialStarted = recordOfferCheckIssuedV2(createAvailabilityPolicyV2(partialWorkspace), partialWorkspace, 'partial-1', versionFor('partial-1'), 'partial-check')
  const partialQuery = recordOffersQueryIssuedV2(partialStarted, ['partial-hotel'], partialWorkspace, 'partial-query', digestV2(criteria), criteria)
  const partialReceipt = offersReceipt('partial-query', 1, ['partial-hotel'], ['partial-2'], 1, 'partial', 'partial', false)
  const partial = recordOffersGenerationV2(partialQuery, ['partial-hotel'], ws(1, ['partial-hotel'], [['partial-1', 'partial-hotel'], ['partial-2', 'partial-hotel'], ['partial-3', 'partial-hotel']]), 'partial-query', digestV2(partialReceipt), partialReceipt, digestV2(criteria), criteria)
  assert.equal(partial.hotels['partial-hotel']?.currentGeneration?.evidence, 'partial')
  assert.equal(partial.hotels['partial-hotel']?.currentOfferRefs.length, 0)
  assert.equal(partial.hotels['partial-hotel']?.freshOffersRequired, true)
  assert.throws(() => recordOffersGenerationV2(partialQuery, ['partial-hotel'], ws(1, ['partial-hotel'], [['partial-1', 'partial-hotel'], ['partial-2', 'partial-hotel']]), 'partial-query', digestV2(offersReceipt('partial-query', 1, ['partial-hotel'], ['partial-1'], 2, 'partial', 'partial', false)), offersReceipt('partial-query', 1, ['partial-hotel'], ['partial-1'], 2, 'partial', 'partial', false), digestV2(criteria), criteria), /availability_offers_count_mismatch/)

  const emptyWorkspace = ws(0, ['empty-hotel'], [['empty-1', 'empty-hotel']])
  const emptyStarted = recordOfferCheckIssuedV2(createAvailabilityPolicyV2(emptyWorkspace), emptyWorkspace, 'empty-1', versionFor('empty-1'), 'empty-check')
  const emptyQuery = recordOffersQueryIssuedV2(emptyStarted, ['empty-hotel'], emptyWorkspace, 'empty-query')
  const empty = offersReceipt('empty-query', 1, ['empty-hotel'], [], 0, 'no_match', 'empty', false)
  assert.throws(() => recordOffersGenerationV2(emptyQuery, ['empty-hotel'], emptyWorkspace, 'empty-query', digestV2(empty), empty), /availability_offers_workspace_mismatch/)
}

// Locked provenance and verification cases: failed ordinary queries erase the
// seed, while a CheckAvail claim is confirmed only by the current workspace's
// verifiedOffer capability; changed is inconclusive and requires a fresh generation.
{
  const seedWorkspace = ws(0, ['seed-hotel'], [['seed-1', 'seed-hotel']])
  const seed = offersReceipt('seed-query', 1, ['seed-hotel'], ['seed-1'], 1)
  const seeded = recordObservedOffersQueryV2(createAvailabilityPolicyV2(seedWorkspace), ['seed-hotel'], digestV2(criteria), seedWorkspace, seed, 'seed-query', digestV2(seed), criteria)
  assert.equal(seeded.criteriaDigest, digestV2(criteria))
  const cleared = recordObservedOffersQueryV2(seeded, ['seed-hotel'], digestV2(criteria), ws(2, ['seed-hotel'], []), gapReceipt('failed-query', 2), 'failed-query', digestV2(gapReceipt('failed-query', 2)), criteria)
  assert.equal(cleared.criteria, undefined)
  assert.equal(cleared.criteriaDigest, undefined)
  assert.equal(cleared.lastQuerySourceActionId, undefined)

  const verificationWorkspace = ws(0, ['verify-hotel'], [['verify-1', 'verify-hotel']])
  const verificationStarted = recordOfferCheckIssuedV2(createAvailabilityPolicyV2(verificationWorkspace), verificationWorkspace, 'verify-1', versionFor('verify-1'), 'verify-check')
  const wrongVerified = { ...verificationWorkspace, revision: 1, verifiedOffer: verifiedCapability('other-offer', versionFor('other-offer')) }
  const wrong = recordOfferCheckReceiptV2(verificationStarted, wrongVerified, receipt('verify-check', 1, 'verify-1', 'applied', true), 'verify-check', 'verify-1', versionFor('verify-1'), 0)
  assert.notEqual(wrong.terminal?.code, 'availability_confirmed')
  assert.equal(wrong.hotels['verify-hotel']?.status, 'inconclusive')

  const matchingStarted = recordOfferCheckIssuedV2(createAvailabilityPolicyV2(verificationWorkspace), verificationWorkspace, 'verify-1', versionFor('verify-1'), 'verify-match')
  const matchingWorkspace = { ...verificationWorkspace, revision: 1, verifiedOffer: verifiedCapability('verify-1') }
  const matching = recordOfferCheckReceiptV2(matchingStarted, matchingWorkspace, receipt('verify-match', 1, 'verify-1', 'applied', true), 'verify-match', 'verify-1', versionFor('verify-1'), 0)
  assert.equal(matching.terminal?.code, 'availability_confirmed')

  const verificationSeedReceipt = offersReceipt('verify-seed', 0, ['verify-hotel'], ['verify-1'], 1)
  const verificationSeed = recordObservedOffersQueryV2(createAvailabilityPolicyV2(verificationWorkspace), ['verify-hotel'], digestV2(criteria), verificationWorkspace, verificationSeedReceipt, 'verify-seed', digestV2(verificationSeedReceipt), criteria)
  const changedStarted = recordOfferCheckIssuedV2(verificationSeed, verificationWorkspace, 'verify-1', versionFor('verify-1'), 'verify-changed')
  const changedReceipt: ActionReceiptV2 = { ...receipt('verify-changed', 1, 'verify-1', 'changed', true, versionFor('verify-1'), versionFor('verify-1', 'v2')), observation: { kind: 'offer.availability', offerRef: 'verify-1', checkedOfferVersionRef: versionFor('verify-1'), currentOfferVersionRef: versionFor('verify-1', 'v2'), available: true, changedFactRefs: ['price'], gapCodes: [] }, resultContract: { outcome: 'partial', hardCriteriaMet: false, factRefs: [], gapCodes: [], blockers: [], relaxationsApplied: [] } }
  const changed = recordOfferCheckReceiptV2(changedStarted, { ...verificationWorkspace, revision: 1, loadedOffers: [{ offerRef: 'verify-1', offerVersionRef: versionFor('verify-1', 'v2'), hotelRef: 'verify-hotel', evidenceLevel: 'rate_loaded', factRefs: [] }] }, changedReceipt, 'verify-changed', 'verify-1', versionFor('verify-1'), 0)
  assert.equal(changed.hotels['verify-hotel']?.status, 'active')
  assert.deepEqual(changed.hotels['verify-hotel']?.currentOfferRefs, ['verify-1'])
  assert.equal(changed.hotels['verify-hotel']?.tombstonedOfferVersionRefs.includes(versionFor('verify-1')), true)
  assert.equal(changed.hotels['verify-hotel']?.freshOffersRequired, false)
}
const initial=ws(0,['h1','h2'],[['o1','h1'],['o2','h1'],['b1','h2']],['b1'])
assert.throws(()=>recordOffersQueryIssuedV2(createAvailabilityPolicyV2(initial),['h1'],initial,'pre-q'),/recovery_not_started/)
let state=recordOfferCheckIssuedV2(createAvailabilityPolicyV2(initial),initial,'o1',versionFor('o1'),'check-1'); assert.deepEqual(state.hotelRefs,['h1','h2']); assert.equal(state.hotels.h1?.offerQueriesIssued,0)
state=recordOfferCheckReceiptV2(state,ws(1,['h1','h2'],[['o1','h1'],['o2','h1'],['b1','h2']]),receipt('check-1',1,'o1'),'check-1','o1',versionFor('o1'),0); assert.equal(state.hotels.h1?.freshOffersRequired,true); assert.equal(canIssueOfferCheckV2(state,ws(1,['h1','h2'],[['o2','h1'],['b1','h2']]),'b1',versionFor('b1')).ok,false)
let q=recordOffersQueryIssuedV2(state,['h1'],ws(1,['h1','h2'],[['o2','h1'],['b1','h2']]),'q1','criteria-a'); assert.throws(()=>recordOffersQueryIssuedV2(q,['h1'],ws(1,['h1','h2'],[]),'q2','criteria-b'),/criteria_changed/)
const staleQueryReceipt: ActionReceiptV2 = {...receipt('q1',2,'o2','stale'),observation:{kind:'gap',code:'stale_revision',factRefs:[]}}
q=foldQuery(q,['h1'],ws(2,['h1','h2'],[['o2','h1'],['b1','h2']]),'q1',staleQueryReceipt,'criteria-a'); assert.equal(q.hotels.h1?.generationNo,1); assert.equal(q.hotels.h1?.currentGeneration?.generationId,'h1:generation:1')
const completeQueryReceipt: ActionReceiptV2 = {...receipt('q2',3,'o2','applied'),observation:{kind:'offers.state',hotelRefs:['h1'],offerRefs:['o2'],loadedHotelCount:1}}
q=recordOffersQueryIssuedV2(q,['h1'],ws(2,['h1','h2'],[['o2','h1'],['b1','h2']]),'q2','criteria-a'); q=foldQuery(q,['h1'],ws(3,['h1','h2'],[['o2','h1'],['b1','h2']]),'q2',completeQueryReceipt,'criteria-a'); assert.deepEqual(q.hotels.h1?.currentOfferRefs,['o2'])
q=recordOfferCheckIssuedV2(q,ws(3,['h1','h2'],[['o2','h1'],['b1','h2']]),'o2',versionFor('o2'),'check-2'); q=recordOfferCheckReceiptV2(q,ws(4,['h1','h2'],[['o2','h1'],['b1','h2']]),receipt('check-2',4,'o2'),'check-2','o2',versionFor('o2'),3); assert.deepEqual(q.hotels.h1?.invalidatedOfferRefs,['o2'])
assert.equal(q.hotels.h1?.freshOffersRequired,false); assert.equal(q.terminal,undefined); assert.throws(()=>recordOffersQueryIssuedV2(q,['h1'],ws(4,['h1','h2'],[['b1','h2']]),'q-after-two-checks','criteria-a'),/hotel_not_active/)
const fw=ws(0,['a','b'],[['a:ratepkg-1','a'],['b:ratepkg-1','b']],['b:ratepkg-1']); let fallback:AvailabilityPolicyStateV2=recordOfferCheckIssuedV2(createAvailabilityPolicyV2(fw),fw,'a:ratepkg-1',versionFor('a:ratepkg-1'),'fa'); fallback=recordOfferCheckReceiptV2(fallback,ws(1,['a','b'],[['a:ratepkg-1','a'],['b:ratepkg-1','b']],['b:ratepkg-1']),receipt('fa',1,'a:ratepkg-1'),'fa','a:ratepkg-1',versionFor('a:ratepkg-1'),0); assert.equal(fallback.hotels.a?.freshOffersRequired,true); fallback=recordOffersQueryIssuedV2(fallback,['a'],ws(1,['a','b'],[['b:ratepkg-1','b']]),'fq1'); const fallbackEmpty: ActionReceiptV2={...receipt('fq1',2,'a:ratepkg-1','no_match'),observation:{kind:'offers.state',hotelRefs:['a'],offerRefs:[],loadedHotelCount:0}}; fallback=foldQuery(fallback,['a'],ws(2,['a','b'],[['b:ratepkg-1','b']]),'fq1',fallbackEmpty); assert.equal(fallback.activeHotelOrdinal,1); assert.equal(canIssueOfferCheckV2(fallback,ws(2,['a','b'],[['b:ratepkg-1','b']]),'b:ratepkg-1',versionFor('b:ratepkg-1')).ok,false); fallback=recordOffersQueryIssuedV2(fallback,['b'],ws(2,['a','b'],[['b:ratepkg-1','b']]),'fq2'); const fallbackOffers: ActionReceiptV2={...receipt('fq2',3,'b:ratepkg-1','applied'),observation:{kind:'offers.state',hotelRefs:['b'],offerRefs:['b:ratepkg-1'],loadedHotelCount:1}}; fallback=foldQuery(fallback,['b'],ws(3,['a','b'],[['b:ratepkg-1','b']]),'fq2',fallbackOffers); assert.equal(canIssueOfferCheckV2(fallback,ws(3,['a','b'],[['b:ratepkg-1','b']]),'b:ratepkg-1',versionFor('b:ratepkg-1')).ok,true)
let exhausted:AvailabilityPolicyStateV2=recordOfferCheckIssuedV2(createAvailabilityPolicyV2(ws(0,['x'],[['x1','x']])),ws(0,['x'],[['x1','x']]),'x1',versionFor('x1'),'ex1'); exhausted=recordOfferCheckReceiptV2(exhausted,ws(1,['x'],[['x1','x']]),receipt('ex1',1,'x1'),'ex1','x1',versionFor('x1'),0); assert.equal(exhausted.terminal,undefined); assert.equal(exhausted.hotels.x?.freshOffersRequired,true); exhausted=recordOffersQueryIssuedV2(exhausted,['x'],ws(1,['x'],[['x1','x']]),'exq'); const exhaustedReceipt: ActionReceiptV2={...receipt('exq',2,'x1','no_match'),observation:{kind:'offers.state',hotelRefs:['x'],offerRefs:[],loadedHotelCount:0}}; exhausted=foldQuery(exhausted,['x'],ws(2,['x'],[]),'exq',exhaustedReceipt); assert.equal(exhausted.hotels.x?.generationNo,2); assert.equal(exhausted.terminal?.code,'availability_exhausted_complete'); assert.throws(()=>recordOfferCheckIssuedV2(exhausted,ws(2,['x'],[]),'x1',versionFor('x1'),'after-terminal'),/availability_terminal/)
// A failed A@v1 must not poison a same-hotel candidate query containing B@v1.
// The reducer filters A's tombstone inside the generation, admits only B, and
// issues the next CheckAvail without getting stuck on the old offer.
{
  const candidateWorkspace = ws(0, ['candidate-hotel'], [['candidate-a', 'candidate-hotel'], ['candidate-b', 'candidate-hotel']], ['candidate-a', 'candidate-b'])
  let candidateState = recordOfferCheckIssuedV2(createAvailabilityPolicyV2(candidateWorkspace), candidateWorkspace, 'candidate-a', versionFor('candidate-a'), 'candidate-a-check')
  candidateState = recordOfferCheckReceiptV2(candidateState, ws(1, ['candidate-hotel'], [['candidate-a', 'candidate-hotel'], ['candidate-b', 'candidate-hotel']], ['candidate-a', 'candidate-b']), receipt('candidate-a-check', 1, 'candidate-a'), 'candidate-a-check', 'candidate-a', versionFor('candidate-a'), 0)
  const queryWorkspace = ws(1, ['candidate-hotel'], [['candidate-a', 'candidate-hotel'], ['candidate-b', 'candidate-hotel']], ['candidate-a', 'candidate-b'])
  const candidateQueryReceipt = offersReceipt('candidate-query', 2, ['candidate-hotel'], ['candidate-a', 'candidate-b'], 1)
  candidateState = recordOffersQueryIssuedV2(candidateState, ['candidate-hotel'], queryWorkspace, 'candidate-query')
  candidateState = recordOffersGenerationV2(candidateState, ['candidate-hotel'], queryWorkspace, 'candidate-query', digestV2(candidateQueryReceipt), candidateQueryReceipt)
  assert.equal(candidateState.hotels['candidate-hotel']?.currentOfferRefs.includes('candidate-a'), false, 'unavailable A@v1 is not re-admitted by a same-hotel candidate query')
  assert.deepEqual(candidateState.hotels['candidate-hotel']?.currentOfferRefs, ['candidate-b'], 'same-hotel candidate query admits B@v1 only')
  assert.equal(candidateState.activeHotelOrdinal, 0, 'same-hotel recovery remains on the active hotel after filtering A')
  const bWorkspace = ws(2, ['candidate-hotel'], [['candidate-b', 'candidate-hotel']], ['candidate-b'])
  assert.equal(canIssueOfferCheckV2(candidateState, bWorkspace, 'candidate-b', versionFor('candidate-b')).ok, true, 'B@v1 is recheckable after A@v1 unavailable')
  candidateState = recordOfferCheckIssuedV2(candidateState, bWorkspace, 'candidate-b', versionFor('candidate-b'), 'candidate-b-check')
  const bVerified = verifiedCapability('candidate-b', versionFor('candidate-b'))
  candidateState = recordOfferCheckReceiptV2(candidateState, ws(3, ['candidate-hotel'], [['candidate-b', 'candidate-hotel']], ['candidate-b'], bVerified), receipt('candidate-b-check', 3, 'candidate-b', 'applied', true), 'candidate-b-check', 'candidate-b', versionFor('candidate-b'), 2)
  assert.equal(candidateState.terminal?.code, 'availability_confirmed', 'recheck of B@v1 can confirm after A@v1 unavailable')
}
console.log('BOOKING COPILOT AVAILABILITY POLICY V2: admission, criteria CAS, stale no-generation, invalidation, cursor fallback, exhaustion, absorbing terminal OK')

// Runtime proof: action replay, restart restoration, terminal SSE batch and absorbing seams.
const ledgerRoot = mkdtempSync(join(tmpdir(), 'gotry-availability-proof-'))
const ledger = ensureLedger(ledgerRoot)
const runtime = new BookingCopilotTaskRuntimeV2(ledger, { contextRefFactory: () => 'ctx-availability' })
const runtimeWorkspace = ws(0, ['rh'], [])
runtime.startTask({ schemaVersion: 'booking.surface.v2', kind: 'user.turn', taskId: 'runtime-availability', turnId: 'turn-1', workspace: runtimeWorkspace, request: { text: 'find rates' } })
const query = { schemaVersion: 'booking.surface.v2' as const, kind: 'offers.query' as const, actionId: 'rq-1', contextRef: 'ctx-availability', expectedRevision: 0, reason: 'ordinary query', factRefs: [], input: { hotelRefs: ['rh'], criteria: {} } }
runtime.issueOperation('runtime-availability', query)
runtime.continueWithReceipt({ schemaVersion: 'booking.surface.v2', kind: 'action.receipt.continuation', taskId: 'runtime-availability', workspace: ws(1, ['rh'], [['ro1', 'rh']]), receipt: { schemaVersion: 'booking.surface.v2', kind: 'action.receipt', actionId: 'rq-1', contextRef: 'ctx-availability', status: 'applied', revision: 1, observation: { kind: 'offers.state', hotelRefs: ['rh'], offerRefs: ['ro1'], loadedHotelCount: 1 }, resultContract: { outcome: 'complete', hardCriteriaMet: true, factRefs: [], gapCodes: [], blockers: [], relaxationsApplied: [] } } })
const check = { schemaVersion: 'booking.surface.v2' as const, kind: 'offer.check' as const, actionId: 'rc-1', contextRef: 'ctx-availability', expectedRevision: 1, reason: 'CheckAvail', factRefs: [], input: { offerRef: 'ro1', offerVersionRef: versionFor('ro1') } }
runtime.issueOperation('runtime-availability', check)
runtime.issueOperation('runtime-availability', check)
assert.equal(runtime.resumeTask('runtime-availability')?.availability.attempts.length, 1)
const restarted = new BookingCopilotTaskRuntimeV2(ensureLedger(ledgerRoot), { contextRefFactory: () => 'ctx-availability' })
assert.equal(restarted.resumeTask('runtime-availability')?.availability.attempts[0]?.actionId, 'rc-1')
runtime.continueWithReceipt({ schemaVersion: 'booking.surface.v2', kind: 'action.receipt.continuation', taskId: 'runtime-availability', workspace: ws(2, ['rh'], [['ro1', 'rh']]), receipt: { ...receipt('rc-1', 2, 'ro1'), status: 'unavailable' } })
const query2 = { ...query, actionId: 'rq-2', expectedRevision: 2 }
runtime.issueOperation('runtime-availability', query2)
runtime.continueWithReceipt({ schemaVersion: 'booking.surface.v2', kind: 'action.receipt.continuation', taskId: 'runtime-availability', workspace: ws(3, ['rh'], []), receipt: { schemaVersion: 'booking.surface.v2', kind: 'action.receipt', actionId: 'rq-2', contextRef: 'ctx-availability', status: 'no_match', revision: 3, observation: { kind: 'offers.state', hotelRefs: ['rh'], offerRefs: [], loadedHotelCount: 0 }, resultContract: { outcome: 'empty', hardCriteriaMet: false, factRefs: [], gapCodes: [], blockers: [], relaxationsApplied: [] } } })
assert.equal(runtime.resumeTask('runtime-availability')?.phase, 'terminal')
const eventCount = ledger.countEvents()
const terminalBatchPayload = ledger.db.prepare("SELECT payload FROM events WHERE kind = 'booking.copilot.v2.decision.batch' ORDER BY seq DESC LIMIT 1").get() as { payload: string }
const terminalBatch = JSON.parse(terminalBatchPayload.payload) as { requestKey: string; events: BookingSurfaceEventV2[] }
assert.deepEqual(runtime.terminalDecisionBatch('runtime-availability', terminalBatch.requestKey), terminalBatch.events)
assert.deepEqual(runtime.terminalDecisionBatch('runtime-availability', terminalBatch.requestKey), terminalBatch.events, 'exact terminal batch replay is read-only')
assert.throws(() => runtime.terminalDecisionBatch('runtime-availability', 'arbitrary-new-terminal-key'), /task_terminal/)
assert.throws(() => runtime.issueOperation('runtime-availability', { ...query, actionId: 'late', expectedRevision: 3 }), /task_terminal/)
assert.throws(() => runtime.emitEvent('runtime-availability', { kind: 'status', status: 'working' }), /task_terminal/)
assert.equal(ledger.countEvents(), eventCount)
ledger.close(); restarted['ledger'].close(); rmSync(ledgerRoot, { recursive: true, force: true })
