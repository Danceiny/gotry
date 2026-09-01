import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensureLedger } from '../src/state-ledger.ts'
import { BookingCopilotTaskRuntimeV2 } from '../src/booking-surface/runtime-v2.ts'
import { createAvailabilityPolicyV2, digestV2, MAX_HOTELS_PER_TASK_V2, MAX_OFFER_CHECKS_PER_HOTEL_V2, MAX_OFFER_QUERIES_PER_HOTEL_V2, recordObservedOffersQueryV2, recordOfferCheckIssuedV2, recordOfferCheckReceiptV2, recordOffersGenerationV2, recordOffersQueryIssuedV2, canIssueOfferCheckV2, type AvailabilityPolicyStateV2 } from '../src/booking-surface/availability-policy-v2.ts'
import { bookingSurfaceAllowedActionsV2 } from '../src/booking-surface/contracts-v2.ts'
import type { ActionReceiptV2, BookingSurfaceEventV2, BookingWorkspaceSnapshotV2 } from '../src/booking-surface/contracts-v2.ts'
import type { OfferCriteriaV1 } from '../src/booking-surface/contracts.ts'
const ws=(revision:number,hotels:string[],offers:Array<[string,string]>,shortlistedOfferRefs:string[]=[]):BookingWorkspaceSnapshotV2=>({schemaVersion:'booking.surface.v2',contextRef:'ctx-availability',surface:'tenant',revision,locale:'en-US',currency:'AED',searchDraft:{},results:{status:'idle'},visibleHotels:hotels.map(h=>({hotelRef:h,name:h,factRefs:[]})),loadedOffers:offers.map(([offerRef,hotelRef])=>({offerRef,hotelRef,evidenceLevel:'rate_loaded',factRefs:[]})),shortlistedOfferRefs,capabilities:{surface:'tenant',allowedActions:['offers.query','offer.check'] as any}})
const receipt=(actionId:string,revision:number,offerRef:string,status:ActionReceiptV2['status']='unavailable',available=false):ActionReceiptV2=>({schemaVersion:'booking.surface.v2',kind:'action.receipt',actionId,contextRef:'ctx-availability',status,revision,observation:{kind:'offer.availability',offerRef,available,verifiedOfferRef:available?'verified-'+offerRef:undefined,changedFactRefs:[],gapCodes:[]},resultContract:{outcome:available?'complete':'empty',hardCriteriaMet:available,factRefs:[],gapCodes:[],blockers:[],relaxationsApplied:[]}})
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

  const unavailableWorkspace = ws(0, ['budget-hotel'], [['budget-offer', 'budget-hotel']])
  let exhausted = recordOfferCheckIssuedV2(createAvailabilityPolicyV2(unavailableWorkspace), unavailableWorkspace, 'budget-offer', 'budget-check-1')
  exhausted = recordOfferCheckReceiptV2(exhausted, ws(1, ['budget-hotel'], [['budget-offer', 'budget-hotel']]), receipt('budget-check-1', 1, 'budget-offer'), 'budget-check-1', 'budget-offer', 0)
  assert.equal(exhausted.hotels['budget-hotel']?.freshOffersRequired, true, 'first unavailable opens exactly one fresh-generation transition')

  exhausted = recordOffersQueryIssuedV2(exhausted, ['budget-hotel'], ws(1, ['budget-hotel'], [['budget-offer', 'budget-hotel']]), 'budget-query-1')
  const refreshedReceipt = offersReceipt('budget-query-1', 2, ['budget-hotel'], ['budget-offer'], 1)
  exhausted = recordOffersGenerationV2(exhausted, ['budget-hotel'], ws(2, ['budget-hotel'], [['budget-offer', 'budget-hotel']]), 'budget-query-1', digestV2(refreshedReceipt), refreshedReceipt)
  exhausted = recordOfferCheckIssuedV2(exhausted, ws(2, ['budget-hotel'], [['budget-offer', 'budget-hotel']]), 'budget-offer', 'budget-check-2')
  exhausted = recordOfferCheckReceiptV2(exhausted, ws(3, ['budget-hotel'], [['budget-offer', 'budget-hotel']]), receipt('budget-check-2', 3, 'budget-offer'), 'budget-check-2', 'budget-offer', 2)
  assert.equal(exhausted.hotels['budget-hotel']?.checksIssued, 2, 'second unavailable consumes the lifetime CheckAvail budget')
  assert.equal(exhausted.terminal?.code, 'availability_exhausted_complete', 'second unavailable reaches conclusive exhaustion')
  assert.throws(() => recordOfferCheckIssuedV2(exhausted, ws(3, ['budget-hotel'], [['budget-offer', 'budget-hotel']]), 'budget-offer', 'budget-check-3'), /availability_terminal/, 'third CheckAvail cannot be issued after terminal exhaustion')

  const unavailableWithGap = (actionId: string, revision: number): ActionReceiptV2 => ({
    ...receipt(actionId, revision, 'budget-offer'),
    resultContract: { outcome: 'empty', hardCriteriaMet: false, factRefs: [], gapCodes: ['offer_unavailable'], blockers: [], relaxationsApplied: [] },
  })
  let inconclusive = recordOfferCheckIssuedV2(createAvailabilityPolicyV2(unavailableWorkspace), unavailableWorkspace, 'budget-offer', 'gap-check-1')
  inconclusive = recordOfferCheckReceiptV2(inconclusive, ws(1, ['budget-hotel'], [['budget-offer', 'budget-hotel']]), unavailableWithGap('gap-check-1', 1), 'gap-check-1', 'budget-offer', 0)
  inconclusive = recordOffersQueryIssuedV2(inconclusive, ['budget-hotel'], ws(1, ['budget-hotel'], [['budget-offer', 'budget-hotel']]), 'gap-query-1')
  const gapRefreshedReceipt = offersReceipt('gap-query-1', 2, ['budget-hotel'], ['budget-offer'], 1)
  inconclusive = recordOffersGenerationV2(inconclusive, ['budget-hotel'], ws(2, ['budget-hotel'], [['budget-offer', 'budget-hotel']]), 'gap-query-1', digestV2(gapRefreshedReceipt), gapRefreshedReceipt)
  inconclusive = recordOfferCheckIssuedV2(inconclusive, ws(2, ['budget-hotel'], [['budget-offer', 'budget-hotel']]), 'budget-offer', 'gap-check-2')
  inconclusive = recordOfferCheckReceiptV2(inconclusive, ws(3, ['budget-hotel'], [['budget-offer', 'budget-hotel']]), unavailableWithGap('gap-check-2', 3), 'gap-check-2', 'budget-offer', 2)
  assert.equal(inconclusive.terminal?.code, 'availability_exhausted_inconclusive', 'an unavailable receipt with a gap never masquerades as conclusive exhaustion')

  let queryBudget = recordOfferCheckIssuedV2(createAvailabilityPolicyV2(unavailableWorkspace), unavailableWorkspace, 'budget-offer', 'query-budget-check')
  queryBudget = recordOfferCheckReceiptV2(queryBudget, ws(1, ['budget-hotel'], [['budget-offer', 'budget-hotel']]), receipt('query-budget-check', 1, 'budget-offer'), 'query-budget-check', 'budget-offer', 0)
  for (const [actionId, revision] of [['query-budget-1', 2], ['query-budget-2', 3] ] as const) {
    queryBudget = recordOffersQueryIssuedV2(queryBudget, ['budget-hotel'], ws(revision - 1, ['budget-hotel'], [['budget-offer', 'budget-hotel']]), actionId)
    const queryReceipt = offersReceipt(actionId, revision, ['budget-hotel'], ['budget-offer'], 1)
    queryBudget = recordOffersGenerationV2(queryBudget, ['budget-hotel'], ws(revision, ['budget-hotel'], [['budget-offer', 'budget-hotel']]), actionId, digestV2(queryReceipt), queryReceipt)
  }
  assert.equal(queryBudget.hotels['budget-hotel']?.offerQueriesIssued, 2, 'two refresh queries are retained as lifetime usage')
  assert.throws(() => recordOffersQueryIssuedV2(queryBudget, ['budget-hotel'], ws(3, ['budget-hotel'], [['budget-offer', 'budget-hotel']]), 'query-budget-3'), /availability_offer_query_limit_reached/, 'third offers.query is rejected')

  const hotels = ['h1', 'h2', 'h3', 'h4', 'h5', 'h6']
  const candidateWorkspace = ws(0, hotels, hotels.map((hotelRef, index) => [`candidate-${index + 1}`, hotelRef]), ['candidate-6', 'candidate-1', 'candidate-2', 'candidate-3', 'candidate-4', 'candidate-5'])
  const candidates = recordOfferCheckIssuedV2(createAvailabilityPolicyV2(candidateWorkspace), candidateWorkspace, 'candidate-6', 'candidate-check')
  assert.deepEqual(candidates.hotelRefs, ['h6', 'h1', 'h2', 'h3', 'h4'], 'selected hotel is first and recovery freezes at five candidates')
  assert.equal(candidates.hotelRefs.includes('h5'), false, 'sixth shortlisted hotel never enters the recovery epoch')
}

// Locked cap and source cases: a selected RoomList offer wins ordering, while
// a complete recovery generation never admits more than three offers.
{
  const roomList = ws(0, ['room-hotel'], [['room-1', 'room-hotel'], ['room-2', 'room-hotel'], ['room-3', 'room-hotel'], ['room-4', 'room-hotel']], ['room-4'])
  const selected = recordOfferCheckIssuedV2(createAvailabilityPolicyV2(roomList), roomList, 'room-4', 'room-check')
  assert.deepEqual(selected.hotels['room-hotel']?.currentOfferRefs, ['room-4', 'room-1', 'room-2'])
  assert.equal(selected.hotels['room-hotel']?.currentGeneration?.source.kind, 'workspace_snapshot')

  const complete = ws(0, ['complete-hotel'], [['complete-1', 'complete-hotel']])
  const completeStarted = recordOfferCheckIssuedV2(createAvailabilityPolicyV2(complete), complete, 'complete-1', 'complete-check')
  const completeQuery = recordOffersQueryIssuedV2(completeStarted, ['complete-hotel'], complete, 'complete-query', digestV2(criteria), criteria)
  const fourOfferWorkspace = ws(1, ['complete-hotel'], [['complete-1', 'complete-hotel'], ['complete-2', 'complete-hotel'], ['complete-3', 'complete-hotel'], ['complete-4', 'complete-hotel']])
  assert.throws(() => recordOffersGenerationV2(completeQuery, ['complete-hotel'], fourOfferWorkspace, 'complete-query', digestV2(offersReceipt('complete-query', 1, ['complete-hotel'], ['complete-1', 'complete-2', 'complete-3', 'complete-4'], 1)), offersReceipt('complete-query', 1, ['complete-hotel'], ['complete-1', 'complete-2', 'complete-3', 'complete-4'], 1), digestV2(criteria), criteria), /availability_offer_limit_exceeded/)
}

// Locked partial/empty reconciliation: a partial receipt may only project an
// evidenced subset, and a clean empty receipt must agree with workspace truth.
{
  const partialWorkspace = ws(0, ['partial-hotel'], [['partial-1', 'partial-hotel'], ['partial-2', 'partial-hotel'], ['partial-3', 'partial-hotel']])
  const partialStarted = recordOfferCheckIssuedV2(createAvailabilityPolicyV2(partialWorkspace), partialWorkspace, 'partial-1', 'partial-check')
  const partialQuery = recordOffersQueryIssuedV2(partialStarted, ['partial-hotel'], partialWorkspace, 'partial-query', digestV2(criteria), criteria)
  const partialReceipt = offersReceipt('partial-query', 1, ['partial-hotel'], ['partial-1'], 1, 'partial', 'partial', false)
  const partial = recordOffersGenerationV2(partialQuery, ['partial-hotel'], ws(1, ['partial-hotel'], [['partial-1', 'partial-hotel'], ['partial-2', 'partial-hotel'], ['partial-3', 'partial-hotel']]), 'partial-query', digestV2(partialReceipt), partialReceipt, digestV2(criteria), criteria)
  assert.equal(partial.hotels['partial-hotel']?.currentGeneration?.evidence, 'partial')
  assert.equal(partial.hotels['partial-hotel']?.currentOfferRefs.length, 0)
  assert.equal(partial.hotels['partial-hotel']?.freshOffersRequired, true)
  assert.throws(() => recordOffersGenerationV2(partialQuery, ['partial-hotel'], ws(1, ['partial-hotel'], [['partial-1', 'partial-hotel'], ['partial-2', 'partial-hotel']]), 'partial-query', digestV2(offersReceipt('partial-query', 1, ['partial-hotel'], ['partial-1'], 2, 'partial', 'partial', false)), offersReceipt('partial-query', 1, ['partial-hotel'], ['partial-1'], 2, 'partial', 'partial', false), digestV2(criteria), criteria), /availability_offers_count_mismatch/)

  const emptyWorkspace = ws(0, ['empty-hotel'], [['empty-1', 'empty-hotel']])
  const emptyStarted = recordOfferCheckIssuedV2(createAvailabilityPolicyV2(emptyWorkspace), emptyWorkspace, 'empty-1', 'empty-check')
  const emptyQuery = recordOffersQueryIssuedV2(emptyStarted, ['empty-hotel'], emptyWorkspace, 'empty-query')
  const empty = offersReceipt('empty-query', 1, ['empty-hotel'], [], 0, 'no_match', 'empty', false)
  assert.throws(() => recordOffersGenerationV2(emptyQuery, ['empty-hotel'], emptyWorkspace, 'empty-query', digestV2(empty), empty), /availability_offers_workspace_mismatch/)
}

// Locked provenance and verification cases: failed ordinary queries erase the
// seed, while a CheckAvail claim is confirmed only by the current workspace's
// verifiedOfferRef; changed is inconclusive and requires a fresh generation.
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
  const verificationStarted = recordOfferCheckIssuedV2(createAvailabilityPolicyV2(verificationWorkspace), verificationWorkspace, 'verify-1', 'verify-check')
  const wrongVerified = { ...verificationWorkspace, revision: 1, verifiedOfferRef: 'verified-other' }
  const wrong = recordOfferCheckReceiptV2(verificationStarted, wrongVerified, receipt('verify-check', 1, 'verify-1', 'applied', true), 'verify-check', 'verify-1', 0)
  assert.notEqual(wrong.terminal?.code, 'availability_confirmed')
  assert.equal(wrong.hotels['verify-hotel']?.status, 'inconclusive')

  const matchingStarted = recordOfferCheckIssuedV2(createAvailabilityPolicyV2(verificationWorkspace), verificationWorkspace, 'verify-1', 'verify-match')
  const matchingWorkspace = { ...verificationWorkspace, revision: 1, verifiedOfferRef: 'verified-verify-1' }
  const matching = recordOfferCheckReceiptV2(matchingStarted, matchingWorkspace, receipt('verify-match', 1, 'verify-1', 'applied', true), 'verify-match', 'verify-1', 0)
  assert.equal(matching.terminal?.code, 'availability_confirmed')

  const changedStarted = recordOfferCheckIssuedV2(createAvailabilityPolicyV2(verificationWorkspace), verificationWorkspace, 'verify-1', 'verify-changed')
  const changedReceipt: ActionReceiptV2 = { ...receipt('verify-changed', 1, 'verify-1', 'changed', false), observation: { kind: 'offer.availability', offerRef: 'verify-1', available: false, changedFactRefs: ['price'], gapCodes: [] }, resultContract: { outcome: 'partial', hardCriteriaMet: false, factRefs: [], gapCodes: [], blockers: [], relaxationsApplied: [] } }
  const changed = recordOfferCheckReceiptV2(changedStarted, { ...verificationWorkspace, revision: 1 }, changedReceipt, 'verify-changed', 'verify-1', 0)
  assert.equal(changed.hotels['verify-hotel']?.status, 'inconclusive')
  assert.equal(changed.hotels['verify-hotel']?.freshOffersRequired, true)
}
const initial=ws(0,['h1','h2'],[['o1','h1'],['o2','h1'],['b1','h2']],['b1'])
assert.throws(()=>recordOffersQueryIssuedV2(createAvailabilityPolicyV2(initial),['h1'],initial,'pre-q'),/recovery_not_started/)
let state=recordOfferCheckIssuedV2(createAvailabilityPolicyV2(initial),initial,'o1','check-1'); assert.deepEqual(state.hotelRefs,['h1','h2']); assert.equal(state.hotels.h1?.offerQueriesIssued,0)
state=recordOfferCheckReceiptV2(state,ws(1,['h1','h2'],[['o1','h1'],['o2','h1'],['b1','h2']]),receipt('check-1',1,'o1'),'check-1','o1',0); assert.equal(state.hotels.h1?.freshOffersRequired,true); assert.equal(canIssueOfferCheckV2(state,ws(1,['h1','h2'],[['o2','h1'],['b1','h2']]),'b1').ok,false)
let q=recordOffersQueryIssuedV2(state,['h1'],ws(1,['h1','h2'],[['o2','h1'],['b1','h2']]),'q1','criteria-a'); assert.throws(()=>recordOffersQueryIssuedV2(q,['h1'],ws(1,['h1','h2'],[]),'q2','criteria-b'),/criteria_changed/)
const staleQueryReceipt: ActionReceiptV2 = {...receipt('q1',2,'o2','stale'),observation:{kind:'gap',code:'stale_revision',factRefs:[]}}
q=foldQuery(q,['h1'],ws(2,['h1','h2'],[['o2','h1'],['b1','h2']]),'q1',staleQueryReceipt,'criteria-a'); assert.equal(q.hotels.h1?.generationNo,1); assert.equal(q.hotels.h1?.currentGeneration?.generationId,'h1:generation:1')
const completeQueryReceipt: ActionReceiptV2 = {...receipt('q2',3,'o2','applied'),observation:{kind:'offers.state',hotelRefs:['h1'],offerRefs:['o2'],loadedHotelCount:1}}
q=recordOffersQueryIssuedV2(q,['h1'],ws(2,['h1','h2'],[['o2','h1'],['b1','h2']]),'q2','criteria-a'); q=foldQuery(q,['h1'],ws(3,['h1','h2'],[['o2','h1'],['b1','h2']]),'q2',completeQueryReceipt,'criteria-a'); assert.deepEqual(q.hotels.h1?.currentOfferRefs,['o2'])
q=recordOfferCheckIssuedV2(q,ws(3,['h1','h2'],[['o2','h1'],['b1','h2']]),'o2','check-2'); q=recordOfferCheckReceiptV2(q,ws(4,['h1','h2'],[['o2','h1'],['b1','h2']]),receipt('check-2',4,'o2'),'check-2','o2',3); assert.deepEqual(q.hotels.h1?.invalidatedOfferRefs,['o2'])
assert.equal(q.hotels.h1?.freshOffersRequired,false); assert.equal(q.terminal,undefined); assert.throws(()=>recordOffersQueryIssuedV2(q,['h1'],ws(4,['h1','h2'],[['b1','h2']]),'q-after-two-checks','criteria-a'),/hotel_not_active/)
const fw=ws(0,['a','b'],[['a1','a'],['b1','b']],['b1']); let fallback:AvailabilityPolicyStateV2=recordOfferCheckIssuedV2(createAvailabilityPolicyV2(fw),fw,'a1','fa'); fallback=recordOfferCheckReceiptV2(fallback,ws(1,['a','b'],[['a1','a'],['b1','b']],['b1']),receipt('fa',1,'a1'),'fa','a1',0); assert.equal(fallback.hotels.a?.freshOffersRequired,true); fallback=recordOffersQueryIssuedV2(fallback,['a'],ws(1,['a','b'],[['b1','b']]),'fq1'); const fallbackEmpty: ActionReceiptV2={...receipt('fq1',2,'a1','no_match'),observation:{kind:'offers.state',hotelRefs:['a'],offerRefs:[],loadedHotelCount:0}}; fallback=foldQuery(fallback,['a'],ws(2,['a','b'],[['b1','b']]),'fq1',fallbackEmpty); assert.equal(fallback.activeHotelOrdinal,1); assert.equal(canIssueOfferCheckV2(fallback,ws(2,['a','b'],[['b1','b']]),'b1').ok,false); fallback=recordOffersQueryIssuedV2(fallback,['b'],ws(2,['a','b'],[['b1','b']]),'fq2'); const fallbackOffers: ActionReceiptV2={...receipt('fq2',3,'b1','applied'),observation:{kind:'offers.state',hotelRefs:['b'],offerRefs:['b1'],loadedHotelCount:1}}; fallback=foldQuery(fallback,['b'],ws(3,['a','b'],[['b1','b']]),'fq2',fallbackOffers); assert.equal(canIssueOfferCheckV2(fallback,ws(3,['a','b'],[['b1','b']]),'b1').ok,true)
let exhausted:AvailabilityPolicyStateV2=recordOfferCheckIssuedV2(createAvailabilityPolicyV2(ws(0,['x'],[['x1','x']])),ws(0,['x'],[['x1','x']]),'x1','ex1'); exhausted=recordOfferCheckReceiptV2(exhausted,ws(1,['x'],[['x1','x']]),receipt('ex1',1,'x1'),'ex1','x1',0); assert.equal(exhausted.terminal,undefined); assert.equal(exhausted.hotels.x?.freshOffersRequired,true); exhausted=recordOffersQueryIssuedV2(exhausted,['x'],ws(1,['x'],[['x1','x']]),'exq'); const exhaustedReceipt: ActionReceiptV2={...receipt('exq',2,'x1','no_match'),observation:{kind:'offers.state',hotelRefs:['x'],offerRefs:[],loadedHotelCount:0}}; exhausted=foldQuery(exhausted,['x'],ws(2,['x'],[]),'exq',exhaustedReceipt); assert.equal(exhausted.hotels.x?.generationNo,2); assert.equal(exhausted.terminal?.code,'availability_exhausted_complete'); assert.throws(()=>recordOfferCheckIssuedV2(exhausted,ws(2,['x'],[]),'x1','after-terminal'),/availability_terminal/)
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
const check = { schemaVersion: 'booking.surface.v2' as const, kind: 'offer.check' as const, actionId: 'rc-1', contextRef: 'ctx-availability', expectedRevision: 1, reason: 'CheckAvail', factRefs: [], input: { offerRef: 'ro1' } }
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
