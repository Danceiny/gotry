import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { BOOKING_READ_ACTION_KINDS_V2, BOOKING_V2_GAP_CODES, BOOKING_V2_BLOCKER_CODES, BOOKING_SURFACE_SCHEMA_V2_SHA256, bookingSurfaceAllowedActionsV2 } from '../src/booking-surface/contracts-v2.ts'
import { validateBookingSurfaceV2, validateBookingReadActionV2, validateBookingSurfaceEventV2, validateCriterionBlockerV2, validateRelaxationApprovalV2, validateApprovalAgainstBlocker } from '../src/booking-surface/validation-v2.ts'

let positive = 0
let negative = 0
function accept(label: string, value: unknown) { assert.equal(validateBookingSurfaceV2(value).ok, true, label); positive++ }
function reject(label: string, value: unknown) { assert.equal(validateBookingSurfaceV2(value).ok, false, label); negative++ }
assert.deepEqual(bookingSurfaceAllowedActionsV2('storefront'), ['search.patch', 'search.run', 'results.view.patch', 'hotel.focus'], 'storefront UAT availability observation is least privilege')
assert.deepEqual(bookingSurfaceAllowedActionsV2('payment_link'), ['search.patch', 'search.run', 'results.view.patch', 'hotel.focus', 'hotel.select'], 'payment_link UAT availability observation is least privilege')
assert.ok(!bookingSurfaceAllowedActionsV2('storefront').includes('offers.query'), 'storefront availability cannot expand into offers')
assert.ok(!bookingSurfaceAllowedActionsV2('payment_link').includes('checkout.prepare'), 'payment_link availability cannot expand into checkout')
const hash = 'a'.repeat(64)
const workspace = { schemaVersion:'booking.surface.v2', contextRef:'ctx-1', surface:'tenant', revision:0, locale:'zh-CN', currency:'AED', searchDraft:{}, results:{status:'idle'}, visibleHotels:[], loadedOffers:[], shortlistedOfferRefs:[], capabilities:{surface:'tenant',allowedActions:[...BOOKING_READ_ACTION_KINDS_V2]} }
const ingressWorkspace: Record<string, unknown> = { ...workspace }; delete ingressWorkspace.contextRef; delete ingressWorkspace.surface; delete ingressWorkspace.capabilities
const inputs: Record<string, unknown> = {
  'search.patch':{patch:{destination:{query:'Dubai'}}}, 'search.run':{}, 'results.view.patch':{patch:{sort:'recommended'}}, 'hotel.focus':{hotelRef:'hotel-1'}, 'hotel.select':{hotelRef:'hotel-1'},
  'offers.query':{hotelRefs:['hotel-1'],criteria:{}}, 'offers.view.patch':{hotelRef:'hotel-1',criteria:{}}, 'offers.compare':{offerRefs:['offer-1'],requestedCount:1},
  'offer.select':{offerRef:'offer-1',offerVersionRef:'offer-1:v1'}, 'offer.check':{offerRef:'offer-1',offerVersionRef:'offer-1:v1'}, 'checkout.prepare':{offerRef:'offer-1',offerVersionRef:'offer-1:v1',verifiedOfferRef:'verified-1'}, 'order.observe':{orderRef:'order-1'},
}
const actions = Object.fromEntries(BOOKING_READ_ACTION_KINDS_V2.map((kind) => [kind,{schemaVersion:'booking.surface.v2',kind,actionId:`a-${kind.replaceAll('.','-')}`,contextRef:'ctx-1',expectedRevision:0,reason:'typed request',factRefs:[],input:inputs[kind]}])) as Record<string, Record<string, unknown>>
const approvalRef = { approvalId:'ap-1', blockerId:'b-1', contextRef:'ctx-1', sourceTurnId:'turn-1', presentationRequestKey:'approval:task-1:turn-1:a-search-run:' + hash, sourceActionId:'a-search-run', targetActionId:'a-search-run', sourceRevision:0, targetActionKind:'search.run', to:'prefer', expiresAt:'2099-01-01T00:00:00.000Z', nonce:'nonce-1', sourceReceiptDigest:hash, scope:'offer', code:'hotel_rates_failed', criterionPath:'offers.totalPriceMax', valueDigest:hash }
accept('valid relaxation approval ref action', {...actions['search.run'], relaxationApprovalRef:approvalRef})
reject('approval context replay', {...actions['search.run'], relaxationApprovalRef:{...approvalRef,contextRef:'ctx-other'}})
reject('approval action replay', {...actions['search.run'], relaxationApprovalRef:{...approvalRef,targetActionId:'a-other'}})
reject('approval future revision replay', {...actions['search.run'], relaxationApprovalRef:{...approvalRef,sourceRevision:1}})
reject('approval old revision replay', {...actions['search.run'],expectedRevision:1,relaxationApprovalRef:{...approvalRef,sourceRevision:0}})
reject('approval target kind replay', {...actions['search.run'], relaxationApprovalRef:{...approvalRef,targetActionKind:'offer.check'}})
reject('approval bad nonce', {...actions['search.run'], relaxationApprovalRef:{...approvalRef,nonce:'Bearer token'}})
reject('approval bad expiry', {...actions['search.run'], relaxationApprovalRef:{...approvalRef,expiresAt:'not-a-date'}})
const openInput = (kind: string): Record<string, unknown> => {
  const input = inputs[kind]
  return input && typeof input === 'object' && !Array.isArray(input) ? { ...input, open: true } : { open: true }
}
for (const kind of BOOKING_READ_ACTION_KINDS_V2) {
  accept(`valid action ${kind}`, actions[kind]); reject(`missing input ${kind}`, {...actions[kind],input:undefined}); reject(`open input ${kind}`, {...actions[kind],input:openInput(kind)})
}
reject('offer.select missing version', {...actions['offer.select'],input:{offerRef:'offer-1'}})
reject('offer.check missing version', {...actions['offer.check'],input:{offerRef:'offer-1'}})
reject('checkout.prepare missing version', {...actions['checkout.prepare'],input:{offerRef:'offer-1',verifiedOfferRef:'verified-1'}})
const versionedWorkspace = {
  ...workspace,
  visibleHotels:[{hotelRef:'hotel-1',name:'Hotel 1',factRefs:['hotel-fact-1']}],
  loadedOffers:[{offerRef:'offer-1',offerVersionRef:'offer-1:v1',hotelRef:'hotel-1',evidenceLevel:'rate_loaded',factRefs:['offer-fact-1']}],
  selectedOfferRef:'offer-1',
  verifiedOffer:{offerRef:'offer-1',offerVersionRef:'offer-1:v1',verifiedOfferRef:'verified-1',expiresAt:'2030-02-28T23:59:59+04:00'},
}
const versionedTurn = {schemaVersion:'booking.surface.v2',kind:'user.turn',taskId:'versioned-task',turnId:'versioned-turn',workspace:versionedWorkspace,request:{text:'find hotels'}}
accept('versioned loaded offer and verified tuple', versionedTurn)
reject('verified offer invalid calendar expiry', {...versionedTurn,workspace:{...versionedWorkspace,verifiedOffer:{...versionedWorkspace.verifiedOffer,expiresAt:'2026-02-30T00:00:00.000Z'}}})
reject('verified offer malformed expiry', {...versionedTurn,workspace:{...versionedWorkspace,verifiedOffer:{...versionedWorkspace.verifiedOffer,expiresAt:'tomorrow'}}})
reject('verified offer missing expiry', {...versionedTurn,workspace:{...versionedWorkspace,verifiedOffer:{...versionedWorkspace.verifiedOffer,expiresAt:undefined}}})
reject('verified offer mismatched logical tuple', {...versionedTurn,workspace:{...versionedWorkspace,verifiedOffer:{...versionedWorkspace.verifiedOffer,offerRef:'offer-other',offerVersionRef:'offer-other:v1'}}})
reject('verified offer mismatched version tuple', {...versionedTurn,workspace:{...versionedWorkspace,verifiedOffer:{...versionedWorkspace.verifiedOffer,offerVersionRef:'offer-1:v2'}}})
reject('workspace duplicate logical offer refs', {...versionedTurn,workspace:{...versionedWorkspace,loadedOffers:[...versionedWorkspace.loadedOffers,{...versionedWorkspace.loadedOffers[0]}]}})
reject('workspace duplicate offer version refs', {...versionedTurn,workspace:{...versionedWorkspace,loadedOffers:[...versionedWorkspace.loadedOffers,{offerRef:'offer-2',offerVersionRef:'offer-1:v1',hotelRef:'hotel-1',evidenceLevel:'rate_loaded',factRefs:[]}]}})
reject('Book', {...actions['search.run'],kind:'book'}); reject('root minimum', {schemaVersion:'booking.surface.v2'}); reject('workspace nested extra', {...workspace,results:{status:'idle',open:true}}); reject('workspace capability Book', {...workspace,capabilities:{...workspace.capabilities,allowedActions:['book']}})
for (const field of ['schemaVersion','kind','actionId','contextRef','expectedRevision']) reject(`action missing ${field}`, Object.fromEntries(Object.entries(actions['search.run']).filter(([key]) => key !== field)))
const blocker = {blockerId:'b-1',sourceActionId:'a-offers-query',sourceReceiptDigest:hash,scope:'offer',code:'hotel_rates_failed',criterionPath:'offers.totalPriceMax',strength:'must',valueDigest:hash,evidence:{factRefs:['fact-1'],gapCodes:['hotel_rates_failed'],requested:2,actual:1}}
const approval = {taskId:'task-1',contextRef:'ctx-1',sourceTurnId:'turn-1',presentationRequestKey:'approval:task-1:turn-1:a-offers-query:' + hash,optionDigest:hash,approvalId:'ap-1',deliveryNonce:'delivery-nonce-1',blockerId:'b-1',sourceActionId:blocker.sourceActionId,sourceReceiptDigest:hash,scope:'offer',code:blocker.code,criterionPath:blocker.criterionPath,valueDigest:hash,from:'must',to:'prefer',approved:true}
assert.equal(validateCriterionBlockerV2(blocker).ok,true); positive++; assert.equal(validateRelaxationApprovalV2(approval).ok,true); positive++; assert.equal(validateApprovalAgainstBlocker(approval,blocker).ok,true); positive++
for (const field of ['sourceReceiptDigest','valueDigest']) { assert.equal(validateCriterionBlockerV2({...blocker,[field]:'bad'}).ok,false); negative++ }
for (const field of ['code','scope','criterionPath']) { assert.equal(validateCriterionBlockerV2({...blocker,[field]:field==='criterionPath'?'open.path':'dynamic'}).ok,false); negative++ }
assert.equal(validateCriterionBlockerV2({...blocker,evidence:{...blocker.evidence,factRefs:['fact-1','fact-1']}}).ok,false); negative++
assert.equal(validateCriterionBlockerV2({...blocker,evidence:{...blocker.evidence,open:true}}).ok,false); negative++
const receipt = {schemaVersion:'booking.surface.v2',kind:'action.receipt',actionId:'a-search-run',contextRef:'ctx-1',status:'partial',revision:1,observation:{kind:'gap',code:'search_failed',factRefs:['fact-1']},resultContract:{outcome:'partial',hardCriteriaMet:false,factRefs:['fact-1'],gapCodes:[...BOOKING_V2_GAP_CODES],blockers:[blocker],relaxationsApplied:[]}}
accept('valid receipt all gap codes',receipt); reject('bad status',{...receipt,status:'unknown'}); reject('bad revision',{...receipt,revision:-1}); reject('bad outcome',{...receipt,resultContract:{...receipt.resultContract,outcome:'bad'}}); reject('dynamic gap',{...receipt,resultContract:{...receipt.resultContract,gapCodes:['dynamic']}}); reject('receipt observation extra',{...receipt,observation:{...receipt.observation,open:true}})
for (const code of BOOKING_V2_GAP_CODES) { accept(`valid declared gap ${code}`, {...receipt, resultContract:{...receipt.resultContract, gapCodes:[code]}}); reject(`dynamic gap ${code}`, {...receipt, resultContract:{...receipt.resultContract, gapCodes:[`${code}:dynamic`]}}) }
const observations = [
  {kind:'search.state',searchSessionRef:'session-1',resultCount:1}, {kind:'results.state',matchedHotelRefs:['hotel-1'],visibleCount:1},
  {kind:'hotel.focus',hotelRef:'hotel-1'}, {kind:'hotel.selection',hotelRef:'hotel-1'}, {kind:'offers.state',hotelRefs:['hotel-1'],offerRefs:['offer-1'],loadedHotelCount:1},
  {kind:'offer.selection',offerRef:'offer-1',offerVersionRef:'offer-1:v1'}, {kind:'offer.availability',offerRef:'offer-1',checkedOfferVersionRef:'offer-1:v1',currentOfferVersionRef:'offer-1:v1',available:true,changedFactRefs:[]},
  {kind:'checkout.handoff',offerRef:'offer-1',offerVersionRef:'offer-1:v1',verifiedOfferRef:'verified-1',handoffRef:'handoff-1'}, {kind:'order.state',orderRef:'order-1',state:'pending'}, {kind:'gap',code:'search_failed',factRefs:['fact-1']},
]
for (const observation of observations) { accept(`valid observation ${observation.kind}`, {...receipt, observation}); reject(`observation extra ${observation.kind}`, {...receipt, observation:{...observation, extra:true}}) }
for (const observation of observations.filter((item) => ['search.state','results.state','offers.state','offer.availability','order.state'].includes(item.kind))) {
  reject(`observation dynamic gap ${observation.kind}`, {...receipt, observation:{...observation, gapCodes:['dynamic']}})
}
reject('gap observation dynamic code', {...receipt, observation:{kind:'gap',code:'dynamic',factRefs:[]}})
const turn={schemaVersion:'booking.surface.v2',kind:'user.turn',taskId:'task-1',turnId:'turn-1',workspace,request:{text:'find hotels'}}; const ingress={schemaVersion:'booking.surface.v2',kind:'user.turn.ingress',requestKey:'request-1',taskHandle:'opaque-task-handle-1',surfaceHint:'tenant',workspace:ingressWorkspace,request:{text:'find hotels'}}; const continuation={schemaVersion:'booking.surface.v2',kind:'action.receipt.continuation',taskId:'task-1',workspace,receipt}
accept('valid user turn',turn); accept('valid ingress',ingress); accept('valid continuation',continuation); reject('empty text',{...turn,request:{text:''}}); reject('multiple approvals',{...turn,request:{text:'x',approval:[approval,approval]}}); accept('text only remains non-approval',{...turn,request:{text:'please relax must'}})
const selectedIngressWorkspace = {...ingressWorkspace,visibleHotels:[{hotelRef:'hotel-1',name:'Hotel 1',factRefs:['hotel-fact-1']}],loadedOffers:[{offerRef:'offer-1',offerVersionRef:'offer-1:v1',hotelRef:'hotel-1',evidenceLevel:'rate_loaded',factRefs:['offer-fact-1']}],focusedHotelRef:'hotel-1',selectedOfferRef:'offer-1'}
accept('ingress preserves visible focus and loaded selection',{...ingress,workspace:selectedIngressWorkspace})
reject('ingress rejects invisible focus',{...ingress,workspace:{...selectedIngressWorkspace,focusedHotelRef:'hotel-other'}})
reject('ingress rejects unloaded selection',{...ingress,workspace:{...selectedIngressWorkspace,selectedOfferRef:'offer-other'}})
reject('ingress rejects selection whose hotel is not visible',{...ingress,workspace:{...selectedIngressWorkspace,visibleHotels:[{hotelRef:'hotel-other',name:'Other',factRefs:[]}]}})
reject('ingress never accepts verified authority',{...ingress,workspace:{...selectedIngressWorkspace,verifiedOfferRef:'verified-offer-1'}})
reject('missing user turn identity',{...turn,turnId:undefined}); reject('missing ingress request key',{...ingress,requestKey:undefined}); reject('unsafe user turn identity',{...turn,turnId:'Bearer token'}); reject('unsafe ingress task handle',{...ingress,taskHandle:'user@example.com'})
reject('missing user task identity',{...turn,taskId:undefined}); reject('browser task identity injection',{...ingress,taskId:'browser-task'}); reject('browser turn identity injection',{...ingress,turnId:'browser-turn'}); reject('browser context identity injection',{...ingress,contextRef:null}); reject('browser verified authority injection',{...ingress,workspace:{...ingressWorkspace,verifiedOfferRef:'verified-offer-1'}})
assert.equal(validateCriterionBlockerV2({...blocker, evidence:{factRefs:[],gapCodes:[]}}).ok,false); negative++
assert.equal(validateApprovalAgainstBlocker({...approval, blockerId:'wrong'}, blocker).ok,false); negative++
const continuationBlocked = {...continuation, receipt:{...receipt,resultContract:{...receipt.resultContract,hardCriteriaMet:true}}}; reject('continuation hard criteria with blocker', continuationBlocked)
reject('formatted phone', {...turn,request:{text:'+971 (50) 123 4567'}}); reject('dotted phone', {...turn,request:{text:'+971.50.123.4567'}}); reject('slash phone', {...turn,request:{text:'call +971/50/123/4567'}}); reject('comma phone', {...turn,request:{text:'call +971,50,123,4567'}}); reject('unicode dash phone', {...turn,request:{text:'call +971—50—123—4567'}}); reject('nbsp phone', {...turn,request:{text:'+971\u00a050\u00a0123\u00a04567'}}); reject('embedded phone', {...turn,request:{text:'call +971 50 123 4567 please'}}); reject('payment card', {...turn,request:{text:'4111 1111 1111 1111'}}); reject('supplier cost', {...turn,request:{text:'supplier net cost AED 42'}}); reject('supplier cost colon', {...turn,request:{text:'supplier net cost: AED 42'}}); reject('supplier possessive cost', {...turn,request:{text:"supplier's net cost AED 42"}}); reject('supplier cost reversed currency', {...turn,request:{text:'supplier cost 42 AED'}}); reject('supplier wholesale', {...turn,request:{text:'supplier wholesale rate AED 42'}}); reject('supplier base bypass', {...turn,request:{text:'supplier base cost AED 42'}}); reject('vendor cost', {...turn,request:{text:'vendor net cost AED 42'}}); reject('vendor compact amount', {...turn,request:{text:'vendor price AED42'}}); reject('internal supplier cost', {...turn,request:{text:'internal supplier cost AED 42'}}); reject('internal reversed amount', {...turn,request:{text:'internal rate 42 USD'}}); reject('contact email bypass', {...turn,request:{text:'contact user@hotelbyte.com'}}); reject('quoted email local part', {...turn,request:{text:'contact "user"@hotelbyte.com'}}); reject('unicode email local part', {...turn,request:{text:'联系 用户@hotelbyte.com'}}); reject('technical-looking real mailbox', {...turn,request:{text:'version@company.com'}}); accept('benign trace identifier', {...turn,request:{text:'trace 0000000000000000'}}); accept('benign sk-ills sentence', {...turn,request:{text:'sk-ills are useful'}}); accept('benign version email', {...turn,request:{text:'version@release.example'}}); accept('benign schema identifier', {...turn,request:{text:'schema@v2.example'}}); accept('benign budget', {...turn,request:{text:'budget AED 1000'}}); accept('benign total price', {...turn,request:{text:'total price under AED 1000'}})
const common={schemaVersion:'booking.surface.v2',eventId:'e-1',taskId:'task-1',contextRef:'ctx-1',sequence:1,emittedAt:'2026-08-30T12:00:00.000Z'}
const questionEvent={...common,kind:'question' as const,question:{questionId:'q-1',prompt:'Relax?',missingFields:[],type:'relaxation_approval_required' as const,blocker,approvalOptions:[{approval}] }}
const events=[{...common,kind:'status' as const,status:'working' as const},questionEvent,{...common,kind:'operation' as const,action:actions['search.run']},{...common,kind:'explanation' as const,explanation:{text:'x',factRefs:[]}},{...common,kind:'terminal' as const,terminal:{status:'completed' as const,summary:'x',factRefs:[]}},{...common,kind:'error' as const,error:{code:'ERR',message:'x',retryable:false}}]
assert.equal(validateBookingSurfaceEventV2({...questionEvent,question:{...questionEvent.question,approvalOptions:[{approval:{...approval,blockerId:'wrong'}}]}}).ok,false); negative++
for (const event of events) accept(`valid event ${event.kind}`,event)
assert.equal(validateBookingSurfaceEventV2({...events[5],eventId:'event-4242-4242-4242-4242'}).ok,true); positive++
assert.equal(validateBookingSurfaceEventV2({...events[3],explanation:{text:'card 4111 1111 1111 1111',factRefs:[]}}).ok,false); negative++
reject('event mixed payload',{...events[0],question:{}}); reject('event missing payload',{...events[1],question:undefined}); reject('event open nested',{...events[4],terminal:{status:'completed',summary:'x',factRefs:[],open:true}})
reject('request key whitespace', {...ingress,requestKey:'request key'}); reject('request key newline', {...ingress,requestKey:'request-1\nnext'}); reject('request key path', {...ingress,requestKey:'request/path'}); reject('request key email', {...ingress,requestKey:'user@example.com'}); reject('request key secret-like', {...ingress,requestKey:'sk-live-abcdefghijkl'}); reject('request key too short', {...ingress,requestKey:'r1'})
accept('ISO date and currency', {...workspace,searchDraft:{stay:{checkIn:'2026-09-01',checkOut:'2026-09-03'}}}); reject('email secret',{...turn,request:{text:'user@example.com'}}); reject('Bearer secret',{...turn,request:{text:'Bearer abc'}}); reject('sk secret',{...turn,request:{text:'sk-live-abcdefghijkl'}}); reject('JWT secret',{...turn,request:{text:'eyJabc.def.ghi'}}); accept('E164-like ordinary date safe',turn)
assert.equal(createHash('sha256').update(readFileSync(new URL('../../schemas/booking.surface.v2.schema.json',import.meta.url))).digest('hex'),BOOKING_SURFACE_SCHEMA_V2_SHA256); console.log(`BOOKING SURFACE V2 CONTRACT PROOF: positive=${positive} negative=${negative}`); assert.ok(positive>=65&&negative>=105)
