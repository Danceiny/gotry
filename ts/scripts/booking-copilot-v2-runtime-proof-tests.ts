import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensureLedger } from '../src/state-ledger.ts'
import { BookingCopilotTaskRuntime } from '../src/booking-surface/runtime.ts'
import {
  BookingCopilotTaskRuntimeV2,
  type BookingCopilotTaskStateV2,
  type BookingPlannerDecisionV2,
} from '../src/booking-surface/runtime-v2.ts'
import { startBookingCopilotServer } from '../src/booking-surface/server.ts'
import { BOOKING_READ_ACTION_KINDS_V2, BOOKING_SURFACE_SCHEMA_VERSION_V2, type BookingReadActionKindV2, type BookingSurfaceV2, type BookingWorkspaceSnapshotV2, type RelaxationApprovalV2 } from '../src/booking-surface/contracts-v2.ts'
import { BOOKING_SURFACE_SCHEMA_V2_SHA256 } from '../src/booking-surface/contracts-v2.ts'
import { BOOKING_SURFACE_SCHEMA_SHA256, BOOKING_SURFACE_SCHEMA_VERSION, type UserTurnV1 } from '../src/booking-surface/contracts.ts'

const stateRoot = mkdtempSync(join(tmpdir(), 'gotry-booking-v2-runtime-'))
const workspace = (revision = 0): BookingWorkspaceSnapshotV2 => ({
  schemaVersion: 'booking.surface.v2', contextRef: 'ctx-v2', surface: 'tenant', revision,
  locale: 'en-US', currency: 'AED', searchDraft: {}, results: { status: 'idle' },
  visibleHotels: [], loadedOffers: [], shortlistedOfferRefs: [],
  capabilities: { surface: 'tenant', allowedActions: [...BOOKING_READ_ACTION_KINDS_V2] },
})
const turn = (taskId: string, revision = 0) => ({
  schemaVersion: 'booking.surface.v2' as const, kind: 'user.turn' as const, taskId,
  turnId: `${taskId}-turn-${revision}`,
  workspace: workspace(revision), request: { text: 'find hotels in Dubai' },
})
const action = (id: string, revision = 0, extra: Record<string, unknown> = {}) => ({
  schemaVersion: 'booking.surface.v2' as const, kind: 'search.run' as const, actionId: id,
  contextRef: 'ctx-v2', expectedRevision: revision, reason: 'search current workspace', factRefs: [], input: {}, ...extra,
})

let id = 0
const runtime = new BookingCopilotTaskRuntimeV2(ensureLedger(stateRoot), {
  idFactory: (prefix) => `${prefix}-${++id}`,
  now: () => '2026-09-01T10:00:00.000Z',
})
const task = runtime.startTask(turn('task-v2'))
assert.equal(task.taskId, 'task-v2')
assert.throws(() => runtime.startTask({ ...turn('task-no-id'), taskId: undefined } as never), /invalid_planner_turn/)
const directIngressRoot = mkdtempSync(join(tmpdir(), 'gotry-booking-v2-missing-task-'))
const directIngressLedger = ensureLedger(directIngressRoot)
const directIngressRuntime = new BookingCopilotTaskRuntimeV2(directIngressLedger)
const directIngressBefore = directIngressLedger.countEvents()
assert.throws(() => directIngressRuntime.startTask({
  schemaVersion: 'booking.surface.v2', kind: 'user.turn.ingress', requestKey: 'ingress-no-task', surfaceHint: 'tenant',
  workspace: { schemaVersion: 'booking.surface.v2', revision: 0, locale: 'en-US', currency: 'AED', searchDraft: {}, results: { status: 'idle' }, visibleHotels: [], loadedOffers: [], shortlistedOfferRefs: [] },
  request: { text: 'find hotels in Dubai' },
} as never), /ingress_binding_required/)
assert.equal(directIngressLedger.countEvents(), directIngressBefore, 'browser ingress has no direct runtime ledger side effects')
const selectedIngressRoot = mkdtempSync(join(tmpdir(), 'gotry-booking-v2-selected-ingress-'))
const selectedIngressLedger = ensureLedger(selectedIngressRoot)
const selectedIngressRuntime = new BookingCopilotTaskRuntimeV2(selectedIngressLedger, { contextRefFactory: () => 'ctx-selected-ingress' })
const selectedIngress = {
  schemaVersion: 'booking.surface.v2' as const, kind: 'user.turn.ingress' as const, requestKey: 'selected-ingress-request', taskHandle: 'opaque-task-handle', surfaceHint: 'tenant' as const,
  workspace: { schemaVersion: 'booking.surface.v2' as const, revision: 0, locale: 'en-US', currency: 'AED', searchDraft: {}, results: { status: 'idle' as const }, visibleHotels: [{ hotelRef: 'hotel-selected', name: 'Selected Hotel', factRefs: [] }], loadedOffers: [{ offerRef: 'offer-selected', hotelRef: 'hotel-selected', evidenceLevel: 'rate_loaded' as const, factRefs: [] }], focusedHotelRef: 'hotel-selected', shortlistedOfferRefs: [], selectedOfferRef: 'offer-selected' },
  request: { text: 'is this selected room still bookable?' },
}
const selectedIngressTask = selectedIngressRuntime.startTask(turn('task-selected-ingress'))
const selectedPlannerTurn = selectedIngressRuntime.bindIngressTurn(selectedIngress, selectedIngressTask, 'turn-selected-ingress')
assert.equal(selectedPlannerTurn.workspace.focusedHotelRef, 'hotel-selected')
assert.equal(selectedPlannerTurn.workspace.selectedOfferRef, 'offer-selected')
assert.equal(selectedPlannerTurn.workspace.verifiedOfferRef, undefined, 'initial ingress cannot assert verified availability authority')
selectedIngressLedger.close(); rmSync(selectedIngressRoot, { recursive: true, force: true })
const operation = runtime.issueOperation(task.taskId, action('action-v2'))
assert.equal(operation.action.actionId, 'action-v2')
assert.equal(operation.action.kind, 'search.run')
assert.equal(runtime.resumeTask(task.taskId)?.pendingAction?.actionId, 'action-v2')
assert.throws(() => runtime.issueOperation(task.taskId, action('wrong-context', 0, { contextRef: 'ctx-other' })), /receipt_required/)
assert.throws(() => runtime.continueWithReceipt({
  schemaVersion: 'booking.surface.v2', kind: 'action.receipt.continuation', taskId: task.taskId,
  workspace: workspace(1), receipt: {
    schemaVersion: 'booking.surface.v2', kind: 'action.receipt', actionId: 'wrong', contextRef: 'ctx-v2',
    status: 'applied', revision: 1, observation: { kind: 'search.state', resultCount: 1 },
    resultContract: { outcome: 'complete', hardCriteriaMet: true, factRefs: [], gapCodes: [], blockers: [], relaxationsApplied: [] },
  },
}), /receipt_action_mismatch/)

const receipt = {
  schemaVersion: 'booking.surface.v2' as const, kind: 'action.receipt' as const, actionId: 'action-v2', contextRef: 'ctx-v2',
  status: 'needs_input' as const, revision: 1, observation: { kind: 'gap' as const, code: 'criterion_must_not_met' as const, factRefs: ['fact-v2'] },
  resultContract: {
    outcome: 'partial' as const, hardCriteriaMet: false, factRefs: ['fact-v2'], gapCodes: ['criterion_must_not_met' as const],
    blockers: [{ blockerId: 'blocker-v2', sourceActionId: 'action-v2', sourceReceiptDigest: '', scope: 'search' as const,
      code: 'criterion_must_not_met' as const, criterionPath: 'searchDraft.destination', strength: 'must' as const,
      valueDigest: 'b'.repeat(64), valueLabel: 'Dubai', evidence: { factRefs: ['fact-v2'], gapCodes: ['criterion_must_not_met' as const] } }],
    relaxationsApplied: [],
  },
}
// The runtime binds sourceReceiptDigest to the durable receipt digest before approval is accepted.
const receiptWithDigest = runtime.withReceiptDigest(receipt)
const afterReceipt = runtime.continueWithReceipt({ schemaVersion: 'booking.surface.v2', kind: 'action.receipt.continuation', taskId: task.taskId, workspace: workspace(1), receipt: receiptWithDigest })
assert.equal(afterReceipt.awaitingApproval?.blocker.blockerId, 'blocker-v2')
const offerRoot = mkdtempSync(join(tmpdir(), 'gotry-booking-v2-offer-target-'))
const offerRuntime = new BookingCopilotTaskRuntimeV2(ensureLedger(offerRoot), { contextRefFactory: () => 'ctx-v2' })
const offerTurn = turn('task-offer-target')
const offerTask = offerRuntime.startTask({ ...offerTurn, workspace: { ...offerTurn.workspace, visibleHotels: [{ hotelRef: 'hotel-a', name: 'Hotel A', factRefs: [] }], loadedOffers: [{ offerRef: 'offer-a', hotelRef: 'hotel-a', evidenceLevel: 'rate_loaded', factRefs: [] }] } })
offerRuntime.issueOperation(offerTask.taskId, { ...action('offer-action'), kind: 'offer.check', input: { offerRef: 'offer-a' } })
const offerReceipt = offerRuntime.withReceiptDigest({ ...receipt, actionId: 'offer-action', observation: { kind: 'offer.availability', offerRef: 'offer-b', available: true, changedFactRefs: [], gapCodes: [] }, resultContract: { ...receipt.resultContract, blockers: [], gapCodes: [] } })
const offerWorkspace1 = { ...offerTurn.workspace, revision: 1, visibleHotels: [{ hotelRef: 'hotel-a', name: 'Hotel A', factRefs: [] }], loadedOffers: [{ offerRef: 'offer-a', hotelRef: 'hotel-a', evidenceLevel: 'rate_loaded' as const, factRefs: [] }] }
assert.throws(() => offerRuntime.continueWithReceipt({ schemaVersion: 'booking.surface.v2', kind: 'action.receipt.continuation', taskId: offerTask.taskId, workspace: offerWorkspace1, receipt: offerReceipt }), /receipt_target_mismatch/)
const approvalQuestion = runtime.approvalQuestion(task.taskId)
assert.equal(approvalQuestion.kind, 'question')
if (approvalQuestion.kind === 'question') {
  assert.equal(approvalQuestion.question.blocker.blockerId, 'blocker-v2')
  assert.equal(approvalQuestion.question.approvalOptions[0]?.approval.sourceActionId, 'action-v2')
}
const awaitingRestart = new BookingCopilotTaskRuntimeV2(ensureLedger(stateRoot), { now: () => '2026-09-01T10:00:00.000Z' })
assert.equal(awaitingRestart.resumeTask(task.taskId)?.awaitingApproval?.blocker.blockerId, 'blocker-v2')
const approval = approvalQuestion.kind === 'question' ? approvalQuestion.question.approvalOptions[0]!.approval : (() => { throw new Error('missing approval option') })()
assert.throws(() => runtime.startTask({ ...turn(task.taskId, 1), request: { text: 'relax destination', approval } }), /approval_not_presented/)
// A persisted outbox intent alone is not a presentation.  If the process
// dies before the durable question batch, even a recovered option is refused.
const awaitingBeforeBatch = runtime.resumeTask(task.taskId)?.awaitingApproval
assert.ok(awaitingBeforeBatch)
const approvalPresentationKey = runtime.approvalPresentationRequestKey(task.taskId)
;(runtime as any).ensureApprovalOffered(task.taskId, task.contextRef, awaitingBeforeBatch!, approvalPresentationKey)
assert.equal(runtime.resumeTask(task.taskId)?.awaitingApproval?.optionsEmitted, false)
assert.throws(() => runtime.startTask({ ...turn(task.taskId, 1), request: { text: 'relax destination', approval } }), /approval_not_presented/)
assert.throws(() => runtime.commitDecisionBatch(task.taskId, 'turn:unrelated-turn', [approvalQuestion]), /approval_presentation_key_mismatch/)
assert.throws(() => runtime.commitDecisionBatch(task.taskId, `approval:other-task:turn-1:action-v2:${'c'.repeat(64)}`, [approvalQuestion]), /approval_presentation_key_mismatch/)
const alteredSourceTurnQuestion = approvalQuestion.kind === 'question' ? { ...approvalQuestion, question: { ...approvalQuestion.question, approvalOptions: approvalQuestion.question.approvalOptions.map(({ approval: option }) => ({ approval: { ...option, sourceTurnId: 'turn-forged' } })) } } : approvalQuestion
assert.throws(() => runtime.commitDecisionBatch(task.taskId, approvalPresentationKey, [alteredSourceTurnQuestion]), /approval_presentation_key_mismatch/)
const alteredReceiptQuestion = approvalQuestion.kind === 'question' ? { ...approvalQuestion, question: { ...approvalQuestion.question, approvalOptions: approvalQuestion.question.approvalOptions.map(({ approval: option }) => ({ approval: { ...option, sourceReceiptDigest: 'd'.repeat(64) } })) } } : approvalQuestion
assert.throws(() => runtime.commitDecisionBatch(task.taskId, approvalPresentationKey, [alteredReceiptQuestion]), /approval_presentation_key_mismatch/)
const alteredOptionQuestion = approvalQuestion.kind === 'question' ? { ...approvalQuestion, question: { ...approvalQuestion.question, approvalOptions: approvalQuestion.question.approvalOptions.map(({ approval: option }) => ({ approval: { ...option, optionDigest: 'e'.repeat(64) } })) } } : approvalQuestion
assert.throws(() => runtime.commitDecisionBatch(task.taskId, approvalPresentationKey, [alteredOptionQuestion]), /approval_presentation_key_mismatch/)
runtime.commitDecisionBatch(task.taskId, approvalPresentationKey, [approvalQuestion])
assert.equal(runtime.resumeTask(task.taskId)?.awaitingApproval?.optionsEmitted, true, 'question batch is the presentation authority')
assert.throws(() => runtime.startTask({ ...turn(task.taskId, 1), request: { text: 'relax destination', approval: { ...approval, deliveryNonce: 'forged-delivery-nonce' } } }), /approval_mismatch/)
runtime.startTask({ ...turn(task.taskId, 1), request: { text: 'relax destination', approval } })
const approvalEventCount = runtime['ledger'].countEvents()
runtime.startTask({ ...turn(task.taskId, 1), request: { text: 'relax destination', approval } })
assert.equal(runtime['ledger'].countEvents(), approvalEventCount, 'identical durable approval retry is idempotent')
assert.throws(() => runtime.startTask({ ...turn(task.taskId, 1), turnId: 'tampered-approval-turn', request: { text: 'relax destination', approval: { ...approval, to: 'drop' } } }), /approval_mismatch/)
const expiredRuntime = new BookingCopilotTaskRuntimeV2(ensureLedger(stateRoot), { now: () => '2026-09-01T10:03:00.000Z' })
assert.throws(() => expiredRuntime.issueOperation(task.taskId, action('action-v2-expired', 1)), /approval_expired/)
const approvedOperation = runtime.issueOperation(task.taskId, action('action-v2-relaxed', 1))
assert.equal(approvedOperation.action.relaxationApprovalRef?.targetActionId, 'action-v2-relaxed')
assert.equal(approvedOperation.action.relaxationApprovalRef?.targetActionKind, 'search.run')
assert.throws(() => runtime.issueOperation(task.taskId, action('action-v2-relaxed-again', 1)), /receipt_required/)

const reopened = new BookingCopilotTaskRuntimeV2(ensureLedger(stateRoot), { now: () => '2026-09-01T10:00:00.000Z' })
assert.equal(reopened.resumeTask(task.taskId)?.lastReceipt?.actionId, 'action-v2')
assert.equal(reopened.resumeTask(task.taskId)?.pendingAction?.actionId, 'action-v2-relaxed')
assert.throws(() => reopened.issueOperation(task.taskId, { ...action('forged-ref', 1), relaxationApprovalRef: { ...approvedOperation.action.relaxationApprovalRef!, targetActionId: 'forged-ref' } }), /receipt_required/)
const forgedTask = runtime.startTask(turn('task-forged', 1))
assert.throws(() => runtime.issueOperation(forgedTask.taskId, action('forged-ref', 1, { relaxationApprovalRef: { ...approvedOperation.action.relaxationApprovalRef!, targetActionId: 'forged-ref' } })), /approval_ref_planner_owned_forbidden/)
const forgedSourceRoot = mkdtempSync(join(tmpdir(), 'gotry-booking-v2-forged-source-'))
const forgedSourceRuntime = new BookingCopilotTaskRuntimeV2(ensureLedger(forgedSourceRoot), { contextRefFactory: () => 'ctx-v2' })
const forgedSourceTask = forgedSourceRuntime.startTask(turn('task-forged-source'))
forgedSourceRuntime.issueOperation(forgedSourceTask.taskId, action('action-real'))
const forgedSourceReceipt = forgedSourceRuntime.withReceiptDigest({ ...receipt, actionId: 'action-real', resultContract: { ...receipt.resultContract, blockers: [{ ...receipt.resultContract.blockers[0]!, sourceActionId: 'action-forged' }] } })
assert.throws(() => forgedSourceRuntime.continueWithReceipt({ schemaVersion: 'booking.surface.v2', kind: 'action.receipt.continuation', taskId: forgedSourceTask.taskId, workspace: workspace(1), receipt: forgedSourceReceipt }), /receipt_source_action_mismatch/)
assert.equal(forgedSourceRuntime.resumeTask(forgedSourceTask.taskId)?.pendingAction?.actionId, 'action-real', 'forged blocker is rejected before receipt append')
const tamperRoot = mkdtempSync(join(tmpdir(), 'gotry-booking-v2-tamper-'))
const tamperLedger = ensureLedger(tamperRoot)
const tamperRuntime = new BookingCopilotTaskRuntimeV2(tamperLedger)
tamperRuntime.startTask(turn('task-tamper'))
tamperLedger.insertEvent({ actor: 'tamper', kind: 'booking.copilot.v2.user.turn.observed', subjectId: 'task-tamper', runId: 'task-tamper', idemKey: 'tamper-turn', payload: { schema: 'booking.copilot.ledger.v2', taskId: 'task-tamper', contextRef: 'ctx-v2', requestDigest: 'tampered', approval: { forged: true } } })
assert.throws(() => tamperRuntime.resumeTask('task-tamper'), /ledger_corrupt:task-tamper:turn_approval/)

const serverRoot = mkdtempSync(join(tmpdir(), 'gotry-booking-v2-server-'))
let serverId = 0
const serverRuntime = new BookingCopilotTaskRuntimeV2(ensureLedger(serverRoot), { idFactory: (prefix) => `${prefix}-server-${++serverId}`, contextRefFactory: () => 'ctx-server' })
let factoryCalls = 0
let plannerCalls = 0
const server = await startBookingCopilotServer({
  apiKey: 'v2-server-key', runtime: new BookingCopilotTaskRuntime(ensureLedger(serverRoot)),
  plannerFactory: (initial) => ({ next: async () => [] }),
  v2: { runtime: serverRuntime, principal: { subject: 'bff-principal-a', scope: 'booking:read' },
  ingressBinding: { bind: () => ({ taskId: 'task-server', turnId: 'ingress-turn-1', contextRef: 'ctx-server', surface: 'tenant', allowedActions: [...BOOKING_READ_ACTION_KINDS_V2] }) },
  plannerFactory: (initial: BookingCopilotTaskStateV2) => { factoryCalls++; return { next: async ({ task: current }) => { plannerCalls++; const decision: BookingPlannerDecisionV2 = { kind: 'operation', action: { ...action(`server-action-${plannerCalls}`, current.revision), contextRef: current.contextRef } }; return [decision] } } },
  },
})
const endpoint = `http://127.0.0.1:${server.port}/a2a/booking-copilot/turn`
const headers = { authorization: 'Bearer v2-server-key', 'content-type': 'application/json', 'x-booking-surface-version': BOOKING_SURFACE_SCHEMA_VERSION_V2, 'x-booking-surface-schema-sha256': BOOKING_SURFACE_SCHEMA_V2_SHA256 }
const ingress = { schemaVersion: 'booking.surface.v2', kind: 'user.turn.ingress', requestKey: 'ingress-request-1', taskHandle: 'opaque-task-handle-1', surfaceHint: 'tenant', workspace: { schemaVersion: 'booking.surface.v2', revision: 0, locale: 'en-US', currency: 'AED', searchDraft: {}, results: { status: 'idle' }, visibleHotels: [], loadedOffers: [], shortlistedOfferRefs: [] }, request: { text: 'find hotels in Dubai' } }
const missingTurnLedgerEvents = serverRuntime['ledger'].countEvents()
const missingIngress = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify({ ...ingress, requestKey: undefined }) })
assert.equal(missingIngress.status, 400, 'missing ingress requestKey is rejected at HTTP schema boundary')
const missingUser = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify({ ...turn('missing-user'), turnId: undefined }) })
assert.equal(missingUser.status, 400, 'missing user turnId is rejected at HTTP schema boundary')
const injectedIngressIdentity = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify({ ...ingress, taskId: 'browser-task', turnId: 'browser-turn', contextRef: null }) })
assert.equal(injectedIngressIdentity.status, 400, 'browser-supplied identity is rejected at HTTP schema boundary')
const missingUserTask = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify({ ...turn('missing-user-task'), taskId: undefined }) })
assert.equal(missingUserTask.status, 400, 'missing user taskId is rejected at HTTP schema boundary')
assert.equal(serverRuntime['ledger'].countEvents(), missingTurnLedgerEvents, 'missing taskId/turnId requests have no ledger side effects')
assert.equal(plannerCalls, 0, 'missing taskId/turnId requests do not call planner')
const first = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(ingress) })
assert.equal(first.status, 200)
const firstBody = await first.text()
assert.match(firstBody, /event: operation/)
assert.equal(factoryCalls, 1)
assert.equal(plannerCalls, 1)
assert.match(firstBody, /ctx-server/)
const ingressReplayWhileWaiting = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(ingress) })
assert.equal(ingressReplayWhileWaiting.status, 200, 'stable ingress turn identity replays while waiting for receipt')
assert.equal(await ingressReplayWhileWaiting.text(), firstBody)
assert.equal(plannerCalls, 1)
const pending = serverRuntime.resumeTask('task-server')?.pendingAction
assert.ok(pending)
const continuationWorkspace = { ...workspace(1), contextRef: 'ctx-server' }
const postActionWorkspace = { ...continuationWorkspace, visibleHotels: [{ hotelRef: 'hotel-a', name: 'Hotel A', factRefs: ['fact-hotel-a'] }] }
const receiptTurn = {
  schemaVersion: 'booking.surface.v2' as const, kind: 'action.receipt.continuation' as const, taskId: 'task-server', workspace: postActionWorkspace,
  receipt: { schemaVersion: 'booking.surface.v2' as const, kind: 'action.receipt' as const, actionId: pending.actionId, contextRef: 'ctx-server', status: 'applied' as const, revision: 1,
    observation: { kind: 'search.state' as const, resultCount: 1 },
    resultContract: { outcome: 'complete' as const, hardCriteriaMet: true, factRefs: [], gapCodes: [], blockers: [], relaxationsApplied: [] } },
}
const [second, concurrentSecond] = await Promise.all([
  fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(receiptTurn) }),
  fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(receiptTurn) }),
])
assert.equal(second.status, 200)
assert.equal(concurrentSecond.status, 200)
const secondBody = await second.text()
const concurrentSecondBody = await concurrentSecond.text()
assert.equal(concurrentSecondBody, secondBody, 'concurrent identical receipt requests receive the same durable typed batch')
assert.equal(plannerCalls, 2)
const replay = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(receiptTurn) })
assert.equal(replay.status, 200)
const replayBody = await replay.text()
assert.equal(plannerCalls, 2, 'identical durable receipt replay does not call planner again')
assert.equal(replayBody, secondBody, 'receipt replay emits the exact durable SSE batch')
const alteredReceiptWorkspace = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify({ ...receiptTurn, workspace: { ...continuationWorkspace, currency: 'USD' } }) })
assert.equal(alteredReceiptWorkspace.status, 409, 'receipt replay binds the full workspace semantics')
const alteredReceiptDraft = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify({ ...receiptTurn, workspace: { ...postActionWorkspace, searchDraft: { destination: { query: 'Abu Dhabi' } } } }) })
assert.equal(alteredReceiptDraft.status, 409, 'receipt rejects unauthorized non-action workspace mutation')
const pendingWithBlocker = serverRuntime.resumeTask('task-server')?.pendingAction
assert.ok(pendingWithBlocker)
const blockerReceipt = serverRuntime.withReceiptDigest({ ...receipt, actionId: pendingWithBlocker.actionId, contextRef: 'ctx-server', revision: 2, resultContract: { ...receipt.resultContract, blockers: [{ ...receipt.resultContract.blockers[0]!, sourceActionId: pendingWithBlocker.actionId }] } })
const blockerTurn = { ...receiptTurn, workspace: { ...continuationWorkspace, revision: 2 }, receipt: blockerReceipt }
const blockerResponse = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(blockerTurn) })
assert.equal(blockerResponse.status, 200)
const blockerBody = await blockerResponse.text()
assert.match(blockerBody, /relaxation_approval_required/)
assert.equal(plannerCalls, 2, 'runtime-owned approval question does not call DSH planner')
const questionApproval = serverRuntime.approvalQuestion('task-server')
assert.equal(questionApproval.kind, 'question')
const deliveredQuestionMatch = /event: question\ndata: ([^\n]+)/.exec(blockerBody)
assert.ok(deliveredQuestionMatch, 'question SSE must be delivered before approval')
const deliveredQuestion = JSON.parse(deliveredQuestionMatch[1]!) as { question: { approvalOptions: Array<{ approval: RelaxationApprovalV2 }> } }
const approved = questionApproval.kind === 'question' ? questionApproval.question.approvalOptions[0]!.approval : undefined
assert.ok(approved)
assert.equal(deliveredQuestion.question.approvalOptions[0]!.approval.deliveryNonce, approved.deliveryNonce, 'SSE carries the durable unpredictable presentation nonce')
const approvedTurn = { schemaVersion: 'booking.surface.v2' as const, kind: 'user.turn' as const, taskId: 'task-server', turnId: 'approval-turn-1', workspace: { ...continuationWorkspace, revision: 2 }, request: { text: 'prefer a nearby match', approval: approved } }
const approvedResponse = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(approvedTurn) })
assert.equal(approvedResponse.status, 200)
const approvedBody = await approvedResponse.text()
assert.equal(plannerCalls, 3)
const crashRoot = mkdtempSync(join(tmpdir(), 'gotry-booking-v2-crash-replay-'))
const crashLedger = ensureLedger(crashRoot)
const crashV2 = new BookingCopilotTaskRuntimeV2(crashLedger)
const crashTurn = { ...turn('task-crash'), turnId: 'stable-turn-1' }
crashV2.startTask(crashTurn)
const crashCount = crashLedger.countEvents()
crashV2.startTask(crashTurn)
assert.equal(crashLedger.countEvents(), crashCount, 'stable turn identity retries after startTask without ledger delta')
const duplicateTextTurn = { ...turn('task-crash'), turnId: 'stable-turn-2' }
crashV2.startTask(duplicateTextTurn)
assert.equal(crashV2.resumeTask('task-crash')?.userTurnCount, 2, 'same text with a new turn identity is a new turn')

// STARTED/TURN/REQUEST_BINDING are one immediate transaction. An injected
// failure at the binding insert rolls back the reservation, so the retry has
// exactly one task and one binding rather than a second planner turn.
const atomicRoot = mkdtempSync(join(tmpdir(), 'gotry-booking-v2-binding-atomic-'))
const atomicLedger = ensureLedger(atomicRoot)
const atomicRuntime = new BookingCopilotTaskRuntimeV2(atomicLedger)
const atomicTurn = turn('task-atomic-binding')
const atomicBinding = { requestKey: 'atomic-request-1', principal: { subject: 'bff-atomic', scope: 'booking:read' }, taskHandle: 'atomic-task-handle' }
atomicLedger.db.exec("CREATE TRIGGER abort_booking_request_binding BEFORE INSERT ON events WHEN NEW.kind = 'booking.copilot.v2.request.binding' BEGIN SELECT RAISE(ABORT, 'crash_after_start_before_binding'); END")
assert.throws(() => atomicRuntime.startTask(atomicTurn, atomicBinding), /crash_after_start_before_binding|SQLITE_CONSTRAINT/)
assert.equal(atomicLedger.countEvents(), 0, 'binding failure rolls back STARTED and TURN reservation')
atomicLedger.db.exec('DROP TRIGGER abort_booking_request_binding')
atomicRuntime.startTask(atomicTurn, atomicBinding)
const atomicCount = atomicLedger.countEvents()
atomicRuntime.startTask(atomicTurn, atomicBinding)
assert.equal(atomicLedger.countEvents(), atomicCount, 'same request binding retry does not create a second task/planner turn')
assert.equal((atomicLedger.db.prepare("SELECT COUNT(*) AS n FROM events WHERE kind = 'booking.copilot.v2.request.binding'").get() as { n: number }).n, 1)
assert.throws(() => atomicRuntime.startTask(atomicTurn, { ...atomicBinding, principal: { subject: 'other-principal', scope: 'booking:read' } }), /principal_conflict|request_conflict/, 'taskHandle cannot be rebound across principals')
assert.throws(() => atomicRuntime.startTask(turn('task-atomic-binding-other'), { ...atomicBinding, requestKey: 'atomic-request-2' }), /task_handle_conflict/, 'taskHandle cannot bind a second task in the same principal scope')
atomicLedger.close(); rmSync(atomicRoot, { recursive: true, force: true })
const v1AfterV2 = new BookingCopilotTaskRuntime(crashLedger)
const v1Turn: UserTurnV1 = { schemaVersion: 'booking.surface.v1', kind: 'user.turn', taskId: 'task-cross-version', workspace: { schemaVersion: 'booking.surface.v1', contextRef: 'ctx-v1', surface: 'tenant', revision: 0, locale: 'en-US', currency: 'AED', searchDraft: {}, results: { status: 'idle' }, visibleHotels: [], loadedOffers: [], shortlistedOfferRefs: [], capabilities: { surface: 'tenant', allowedActions: ['search.run'] } }, request: { text: 'v1 cross-version test' } }
const crossV2 = new BookingCopilotTaskRuntimeV2(crashLedger)
crossV2.startTask({ ...turn('task-cross-version'), workspace: { ...workspace(), contextRef: 'ctx-v2' } })
assert.throws(() => v1AfterV2.startTask(v1Turn), /task_conflict:protocol_version/)
const reverseRoot = mkdtempSync(join(tmpdir(), 'gotry-booking-v2-reverse-version-'))
const reverseLedger = ensureLedger(reverseRoot)
const reverseV1 = new BookingCopilotTaskRuntime(reverseLedger)
reverseV1.startTask(v1Turn)
const reverseV2 = new BookingCopilotTaskRuntimeV2(reverseLedger)
assert.throws(() => reverseV2.startTask({ ...turn('task-cross-version'), workspace: { ...workspace(), contextRef: 'ctx-v1' } }), /task_conflict:protocol_version/)
const terminalRoot = mkdtempSync(join(tmpdir(), 'gotry-booking-v2-terminal-replay-'))
const terminalLedger = ensureLedger(terminalRoot)
const terminalRuntime = new BookingCopilotTaskRuntimeV2(terminalLedger)
const terminalTurn = { ...turn('task-terminal'), turnId: 'terminal-turn-1' }
terminalRuntime.startTask(terminalTurn)
terminalRuntime.applyDecisionBatch('task-terminal', 'turn:task-terminal:terminal-turn-1', [{ kind: 'terminal', terminal: { status: 'completed', summary: 'read-only result', factRefs: [] } }], true)
assert.equal(terminalRuntime.resumeTask('task-terminal')?.phase, 'terminal')
const terminalCount = terminalLedger.countEvents()
assert.throws(() => terminalRuntime.startTask(terminalTurn), /task_terminal/)
assert.equal(terminalLedger.countEvents(), terminalCount, 'terminal exact replay does not append a turn')
assert.throws(() => terminalRuntime.startTask({ ...terminalTurn, turnId: 'terminal-new-turn' }), /task_terminal/)

// A planner batch has one final boundary at most, and the boundary is last.
// Reject malformed batches before any EVENT row is emitted.
const finalityRoot = mkdtempSync(join(tmpdir(), 'gotry-booking-v2-batch-finality-'))
const finalityLedger = ensureLedger(finalityRoot)
const finalityRuntime = new BookingCopilotTaskRuntimeV2(finalityLedger)
finalityRuntime.startTask(turn('task-batch-finality'))
const finalityRows = finalityLedger.countEvents()
const finalityBytes = (finalityLedger.db.prepare('SELECT COALESCE(SUM(length(payload)), 0) AS n FROM events').get() as { n: number }).n
const finalDecision = { kind: 'terminal' as const, terminal: { status: 'completed' as const, summary: 'one final', factRefs: [] } }
assert.throws(() => finalityRuntime.applyDecisionBatch('task-batch-finality', 'batch-two-finals', [finalDecision, finalDecision], true), /decision_batch_finality/)
assert.throws(() => finalityRuntime.applyDecisionBatch('task-batch-finality', 'batch-after-final', [finalDecision, { kind: 'explanation', explanation: { text: 'must not follow final', factRefs: [] } }], true), /decision_batch_finality/)
assert.equal(finalityLedger.countEvents(), finalityRows, 'malformed final batches emit no events')
assert.equal((finalityLedger.db.prepare('SELECT COALESCE(SUM(length(payload)), 0) AS n FROM events').get() as { n: number }).n, finalityBytes, 'malformed final batches do not alter payload bytes')
finalityLedger.close(); rmSync(finalityRoot, { recursive: true, force: true })

// Internal decision ids are runtime-owned and may exceed the browser key
// envelope. Long legal task/turn/action refs must still be replayable.
const longRoot = mkdtempSync(join(tmpdir(), 'gotry-booking-v2-internal-key-'))
const longLedger = ensureLedger(longRoot)
const longRuntime = new BookingCopilotTaskRuntimeV2(longLedger)
const longTaskId = `task-${'t'.repeat(180)}`
const longTurnId = `turn-${'u'.repeat(180)}`
const longActionId = `action-${'a'.repeat(180)}`
longRuntime.startTask({ ...turn(longTaskId), turnId: longTurnId })
const longDecisionKey = `turn:${longTaskId}:${longTurnId}:${longActionId}`
const longDecisionEvents = longRuntime.applyDecisionBatch(longTaskId, longDecisionKey, [{ kind: 'operation', action: action(longActionId) }])
assert.equal(longDecisionEvents.some((event) => event.kind === 'operation' && event.action.actionId === longActionId), true, 'long internal decision key is accepted')
longLedger.close(); rmSync(longRoot, { recursive: true, force: true })

// The operation budget is task-scoped and folded from durable action/receipt
// rows, so a fresh runtime instance must enforce the same absorbing terminal.
const budgetRoot = mkdtempSync(join(tmpdir(), 'gotry-booking-v2-operation-budget-'))
const budgetLedger = ensureLedger(budgetRoot)
const budgetRuntime = new BookingCopilotTaskRuntimeV2(budgetLedger)
const budgetTaskId = 'task-operation-budget'
budgetRuntime.startTask(turn(budgetTaskId))
let twentiethContinuation: any
for (let ordinal = 1; ordinal <= 20; ordinal++) {
  const currentTurn = { ...turn(budgetTaskId), turnId: `budget-turn-${ordinal}` }
  if (ordinal > 1) budgetRuntime.startTask(currentTurn)
  const operation = budgetRuntime.issueOperation(budgetTaskId, action(`budget-action-${ordinal}`))
  const continuation = { schemaVersion: 'booking.surface.v2' as const, kind: 'action.receipt.continuation' as const, taskId: budgetTaskId, workspace: workspace(0), receipt: budgetRuntime.withReceiptDigest({
    schemaVersion: 'booking.surface.v2' as const, kind: 'action.receipt' as const, actionId: operation.action.actionId, contextRef: 'ctx-v2', status: 'applied' as const, revision: 0,
    observation: { kind: 'search.state' as const, resultCount: 0 }, resultContract: { outcome: 'complete' as const, hardCriteriaMet: true, factRefs: [], gapCodes: [], blockers: [], relaxationsApplied: [] },
  }) }
  const folded = budgetRuntime.continueWithReceipt(continuation)
  assert.equal(folded.operationCount, ordinal)
  if (ordinal === 19) assert.equal(folded.phase, 'planning', '19th receipt remains continuable')
  if (ordinal === 20) { assert.equal(folded.phase, 'terminal'); twentiethContinuation = continuation }
}
assert.equal(budgetRuntime.resumeTask(budgetTaskId)?.operationCount, 20)
assert.equal((budgetLedger.db.prepare("SELECT COUNT(*) AS n FROM events WHERE kind = 'booking.copilot.v2.event.emitted' AND json_extract(payload, '$.eventKind') = 'terminal'").get() as { n: number }).n, 1, '20th receipt emits one durable terminal event')
const terminalBatchCount = budgetLedger.countEvents()
const terminalBatchBytes = (budgetLedger.db.prepare('SELECT COALESCE(SUM(length(payload)), 0) AS n FROM events').get() as { n: number }).n
const budgetRestart = new BookingCopilotTaskRuntimeV2(ensureLedger(budgetRoot))
assert.equal(budgetRestart.resumeTask(budgetTaskId)?.operationCount, 20, 'operation count survives restart')
assert.throws(() => budgetRestart.startTask({ ...turn(budgetTaskId), turnId: 'budget-turn-21' }), /task_terminal/)
assert.throws(() => budgetRestart.issueOperation(budgetTaskId, action('budget-action-21')), /task_terminal/)
assert.equal(budgetRestart.continueWithReceipt(twentiethContinuation).phase, 'terminal', 'exact terminal receipt replay is read-only')
assert.throws(() => budgetRestart.emitEvent(budgetTaskId, { kind: 'explanation', explanation: { text: 'must reject', factRefs: [] } }), /task_terminal/)
assert.throws(() => budgetRestart.terminalDecisionBatch(budgetTaskId, 'arbitrary-terminal-key'), /task_terminal/)
assert.throws(() => budgetRestart.applyDecisionBatch(budgetTaskId, 'arbitrary-terminal-key-2', [{ kind: 'terminal', terminal: { status: 'stopped', summary: 'must reject', factRefs: [] } }]), /task_terminal/)
assert.throws(() => budgetRestart.commitDecisionBatch(budgetTaskId, 'arbitrary-terminal-key-3', []), /task_terminal/)
assert.equal(budgetLedger.countEvents(), terminalBatchCount, 'post-terminal attempts do not mutate ledger')
assert.equal((budgetLedger.db.prepare('SELECT COALESCE(SUM(length(payload)), 0) AS n FROM events').get() as { n: number }).n, terminalBatchBytes, 'post-terminal attempts do not mutate ledger bytes')
budgetRestart['ledger'].close(); budgetLedger.close(); rmSync(budgetRoot, { recursive: true, force: true })

// Per-requestKey bindings survive later turns and bind the request digest and
// all workspace capability boundaries; a changed body under the same key is
// a conflict, while replay of the original key is byte-for-byte durable.
const bindingRoot = mkdtempSync(join(tmpdir(), 'gotry-booking-v2-request-binding-'))
const bindingRuntime = new BookingCopilotTaskRuntimeV2(ensureLedger(bindingRoot))
const bindingTurn1 = { ...turn('task-request-binding'), turnId: 'binding-turn-1' }
bindingRuntime.startTask(bindingTurn1)
bindingRuntime.persistRequestBinding('request-one', bindingTurn1, { requestKey: 'request-one', principal: { subject: 'binding-principal', scope: 'booking:read' } })
const firstBatch = bindingRuntime.applyDecisionBatch('task-request-binding', 'request-one', [{ kind: 'explanation', explanation: { text: 'first', factRefs: [] } }], true)
const afterFirstBatch = bindingRuntime['ledger'].countEvents()
bindingRuntime.startTask({ ...bindingTurn1, turnId: 'binding-turn-2' })
const bindingTurn2 = { ...bindingTurn1, turnId: 'binding-turn-2' }
bindingRuntime.persistRequestBinding('request-two', bindingTurn2, { requestKey: 'request-two', principal: { subject: 'binding-principal', scope: 'booking:read' } })
assert.deepEqual(bindingRuntime.applyDecisionBatch('task-request-binding', 'request-one', [{ kind: 'error', error: { code: 'forged', message: 'forged', retryable: false } }]), firstBatch, 'R1 replay returns original durable batch after R2')
assert.equal(bindingRuntime['ledger'].countEvents(), afterFirstBatch + 2, 'R1 replay and R2 binding do not append a replacement batch')
assert.throws(() => bindingRuntime.assertRequestBinding('request-one', { ...bindingTurn1, request: { text: 'changed body' } }, { requestKey: 'request-one', principal: { subject: 'binding-principal', scope: 'booking:read' } }), /request_conflict/)
bindingRuntime['ledger'].close(); rmSync(bindingRoot, { recursive: true, force: true })

// Old action/receipt rows without the new ordinal field fold in ACTION order.
const legacyRoot = mkdtempSync(join(tmpdir(), 'gotry-booking-v2-legacy-ordinal-'))
const legacyLedger = ensureLedger(legacyRoot)
const legacyRuntime = new BookingCopilotTaskRuntimeV2(legacyLedger)
legacyRuntime.startTask(turn('task-legacy-ordinal'))
const legacyOperation = legacyRuntime.issueOperation('task-legacy-ordinal', action('legacy-action'))
legacyLedger.db.prepare("UPDATE events SET payload = json_remove(payload, '$.operationCount') WHERE kind = 'booking.copilot.v2.action.issued'").run()
const legacyReceipt = legacyRuntime.withReceiptDigest({ schemaVersion: 'booking.surface.v2', kind: 'action.receipt', actionId: legacyOperation.action.actionId, contextRef: 'ctx-v2', status: 'applied', revision: 0, observation: { kind: 'search.state', resultCount: 0 }, resultContract: { outcome: 'complete', hardCriteriaMet: true, factRefs: [], gapCodes: [], blockers: [], relaxationsApplied: [] } })
legacyRuntime.continueWithReceipt({ schemaVersion: 'booking.surface.v2', kind: 'action.receipt.continuation', taskId: 'task-legacy-ordinal', workspace: workspace(0), receipt: legacyReceipt })
legacyLedger.db.prepare("UPDATE events SET payload = json_remove(payload, '$.operationCount') WHERE kind = 'booking.copilot.v2.receipt.observed'").run()
const legacyRestart = new BookingCopilotTaskRuntimeV2(ensureLedger(legacyRoot))
assert.equal(legacyRestart.resumeTask('task-legacy-ordinal')?.operationCount, 1, 'legacy action and receipt rows recover operation ordinal')
legacyRestart['ledger'].close(); legacyLedger.close(); rmSync(legacyRoot, { recursive: true, force: true })

const ordinalTamperRoot = mkdtempSync(join(tmpdir(), 'gotry-booking-v2-ordinal-tamper-'))
const ordinalTamperLedger = ensureLedger(ordinalTamperRoot)
const ordinalTamperRuntime = new BookingCopilotTaskRuntimeV2(ordinalTamperLedger)
ordinalTamperRuntime.startTask(turn('task-ordinal-tamper'))
ordinalTamperRuntime.issueOperation('task-ordinal-tamper', action('ordinal-action'))
ordinalTamperLedger.db.prepare("UPDATE events SET payload = json_set(payload, '$.operationCount', 7) WHERE kind = 'booking.copilot.v2.action.issued'").run()
const ordinalRestart = new BookingCopilotTaskRuntimeV2(ensureLedger(ordinalTamperRoot))
assert.throws(() => ordinalRestart.resumeTask('task-ordinal-tamper'), /ledger_corrupt:task-ordinal-tamper:action/, 'inconsistent explicit operation ordinal is rejected')
ordinalRestart['ledger'].close(); ordinalTamperLedger.close(); rmSync(ordinalTamperRoot, { recursive: true, force: true })

const approvedReplay = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(approvedTurn) })
assert.equal(approvedReplay.status, 200)
assert.equal(await approvedReplay.text(), approvedBody, 'approved user-turn retry replays the durable batch while waiting for receipt')
assert.equal(plannerCalls, 3, 'approved user-turn replay does not call planner or append')
const alteredTextReplay = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify({ ...approvedTurn, request: { ...approvedTurn.request, text: 'different request' } }) })
assert.equal(alteredTextReplay.status, 409, 'altered request text cannot replay a waiting batch')
const alteredContextReplay = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify({ ...approvedTurn, workspace: { ...approvedTurn.workspace, contextRef: 'ctx-forged' } }) })
assert.equal(alteredContextReplay.status, 409, 'cross-context request cannot replay a waiting batch')
const alteredApprovalReplay = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify({ ...approvedTurn, request: { ...approvedTurn.request, approval: { ...approved, to: 'drop' } } }) })
assert.equal(alteredApprovalReplay.status, 409, 'altered approval tuple cannot replay a waiting batch')
const alteredCapabilitiesReplay = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify({ ...approvedTurn, workspace: { ...approvedTurn.workspace, capabilities: { ...approvedTurn.workspace.capabilities, allowedActions: [approvedTurn.workspace.capabilities.allowedActions[0]!, approvedTurn.workspace.capabilities.allowedActions[0]!] } } }) })
assert.ok([400, 409].includes(alteredCapabilitiesReplay.status), 'altered capabilities cannot replay a waiting batch')
const ingressReplay = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify({ ...ingress, workspace: { ...ingress.workspace, revision: 2 }, request: { text: 'prefer a nearby match' } }) })
assert.equal(ingressReplay.status, 409, 'unbound ingress cannot replay an existing task')
assert.equal(plannerCalls, 3)
const v1Conflict = await fetch(endpoint, { method: 'POST', headers: { authorization: 'Bearer v2-server-key', 'content-type': 'application/json', 'x-booking-surface-version': BOOKING_SURFACE_SCHEMA_VERSION, 'x-booking-surface-schema-sha256': BOOKING_SURFACE_SCHEMA_SHA256 }, body: JSON.stringify({ schemaVersion: 'booking.surface.v1', kind: 'user.turn', taskId: 'task-server', workspace: { schemaVersion: 'booking.surface.v1', contextRef: 'ctx-server', surface: 'tenant', revision: 1, locale: 'en-US', currency: 'AED', searchDraft: {}, results: { status: 'ready' }, visibleHotels: [], loadedOffers: [], shortlistedOfferRefs: [], capabilities: { surface: 'tenant', allowedActions: ['search.run'] } }, request: { text: 'v1 must not share a v2 task id' } }) })
assert.equal(v1Conflict.status, 409, 'one task id cannot cross protocol versions on the unified server')
await server.close()
const defaultBindingRoot = mkdtempSync(join(tmpdir(), 'gotry-booking-v2-default-binding-'))
const defaultBindingLedger = ensureLedger(defaultBindingRoot)
const defaultBindingRuntime = new BookingCopilotTaskRuntimeV2(defaultBindingLedger)
await assert.rejects(startBookingCopilotServer({
  apiKey: 'default-binding-key',
  runtime: new BookingCopilotTaskRuntime(defaultBindingLedger),
  plannerFactory: () => ({ next: async () => [] }),
  v2: { runtime: defaultBindingRuntime, plannerFactory: () => ({ next: async () => [{ kind: 'terminal', terminal: { status: 'stopped', summary: 'default binding', factRefs: [] } }] }) },
}), /booking_copilot_v2_ingress_binding_required/, 'production composition rejects unusable v2 before listening')
assert.equal(defaultBindingLedger.countEvents(), 0, 'unbound browser ingress has no ledger side effects')
defaultBindingLedger.close(); rmSync(defaultBindingRoot, { recursive: true, force: true })

// HTTP ingress retries after terminal are allowed only for the exact durable
// request batch; a new request key remains fail-closed and cannot append.
const terminalServerRoot = mkdtempSync(join(tmpdir(), 'gotry-booking-v2-http-terminal-replay-'))
const terminalServerLedger = ensureLedger(terminalServerRoot)
const terminalServerRuntime = new BookingCopilotTaskRuntimeV2(terminalServerLedger)
const terminalServer = await startBookingCopilotServer({
  apiKey: 'terminal-server-key',
  v2: {
    runtime: terminalServerRuntime,
    principal: { subject: 'bff-terminal', scope: 'booking:read' },
    ingressBinding: { bind: () => ({ taskId: 'task-http-terminal', turnId: 'http-terminal-turn', contextRef: 'ctx-server', surface: 'tenant', allowedActions: [...BOOKING_READ_ACTION_KINDS_V2] }) },
    plannerFactory: () => ({ next: async () => [{ kind: 'terminal', terminal: { status: 'stopped', summary: 'terminal replay', factRefs: [] } }] }),
  },
})
const terminalIngressEndpoint = `http://127.0.0.1:${terminalServer.port}/a2a/booking-copilot/turn`
const terminalIngress = { ...ingress, requestKey: 'terminal-request-1' }
const terminalIngressHeaders = { ...headers, authorization: 'Bearer terminal-server-key' }
const terminalFirst = await fetch(terminalIngressEndpoint, { method: 'POST', headers: terminalIngressHeaders, body: JSON.stringify(terminalIngress) })
assert.equal(terminalFirst.status, 200)
const terminalFirstBody = await terminalFirst.text()
const terminalIngressCount = terminalServerLedger.countEvents()
const terminalReplay = await fetch(terminalIngressEndpoint, { method: 'POST', headers: terminalIngressHeaders, body: JSON.stringify(terminalIngress) })
assert.equal(terminalReplay.status, 200)
assert.equal(await terminalReplay.text(), terminalFirstBody, 'terminal ingress exact request batch replays after terminal')
assert.equal(terminalServerLedger.countEvents(), terminalIngressCount)
const terminalNewRequest = await fetch(terminalIngressEndpoint, { method: 'POST', headers: terminalIngressHeaders, body: JSON.stringify({ ...terminalIngress, requestKey: 'terminal-request-2' }) })
assert.equal(terminalNewRequest.status, 409, 'new terminal ingress request key is rejected')
assert.equal(terminalServerLedger.countEvents(), terminalIngressCount)
await terminalServer.close(); terminalServerLedger.close(); rmSync(terminalServerRoot, { recursive: true, force: true })

// The BFF binding owns surface authority. Storefront/payment_link cannot be
// escalated to offer, checkout, or order actions, and a browser hint mismatch
// is rejected rather than changing the bound authority.
for (const [surface, taskId, allowedActions, hint] of [
  ['storefront', 'task-storefront-escalation', [...BOOKING_READ_ACTION_KINDS_V2], 'storefront'],
  ['payment_link', 'task-payment-escalation', [...BOOKING_READ_ACTION_KINDS_V2], 'payment_link'],
  ['tenant', 'task-surface-mismatch', [...BOOKING_READ_ACTION_KINDS_V2], 'storefront'],
] satisfies Array<readonly [BookingSurfaceV2, string, readonly BookingReadActionKindV2[], BookingSurfaceV2]>) {
  const matrixRoot = mkdtempSync(join(tmpdir(), `gotry-booking-v2-${taskId}-`))
  const matrixLedger = ensureLedger(matrixRoot)
  const matrixRuntime = new BookingCopilotTaskRuntimeV2(matrixLedger)
  const matrixServer = await startBookingCopilotServer({
    apiKey: `${taskId}-key`,
    v2: {
      runtime: matrixRuntime,
      principal: { subject: 'bff-matrix', scope: 'booking:read' },
      ingressBinding: { bind: () => ({ taskId, turnId: `${taskId}-turn`, contextRef: 'ctx-server', surface, allowedActions: [...allowedActions] }) },
      plannerFactory: () => ({ next: async () => [{ kind: 'terminal', terminal: { status: 'stopped', summary: 'must not plan', factRefs: [] } }] }),
    },
  })
  const matrixResponse = await fetch(`http://127.0.0.1:${matrixServer.port}/a2a/booking-copilot/turn`, { method: 'POST', headers: { ...headers, authorization: `Bearer ${taskId}-key` }, body: JSON.stringify({ ...ingress, requestKey: `${taskId}-request`, surfaceHint: hint }) })
  assert.equal(matrixResponse.status, 502, `${surface} binding escalation/mismatch is rejected before planning`)
  assert.equal(matrixLedger.countEvents(), 0)
  await matrixServer.close(); matrixLedger.close(); rmSync(matrixRoot, { recursive: true, force: true })
}

// Runtime/planner exceptions are always a non-empty typed error SSE event;
// neither an unsupported operation nor raw planner text becomes durable.
for (const [label, plannerFactory, expectedCode] of [
  ['runtime-unsupported-action', () => ({ next: async () => [{ kind: 'operation' as const, action: { ...action('disallowed-http-action'), kind: 'offers.query' as const, input: { hotelRefs: ['hotel-a'], criteria: {} } } }] }), 'UNSUPPORTED_ACTION'],
  ['planner-surface-unsupported', () => ({ next: async () => { throw new Error('planner_surface_action_unsupported: raw internal detail') } }), 'PLANNER_SURFACE_ACTION_UNSUPPORTED'],
] as const) {
  const errorRoot = mkdtempSync(join(tmpdir(), `gotry-booking-v2-${label}-`))
  const errorLedger = ensureLedger(errorRoot)
  const errorRuntime = new BookingCopilotTaskRuntimeV2(errorLedger)
  const errorTaskId = `task-${label}`
  let errorPlannerCalls = 0
  const errorServer = await startBookingCopilotServer({
    apiKey: `${label}-key`,
    v2: {
      runtime: errorRuntime,
      principal: { subject: `bff-${label}`, scope: 'booking:read' },
      ingressBinding: { bind: () => ({ taskId: errorTaskId, turnId: `${errorTaskId}-turn`, contextRef: 'ctx-v2', surface: 'tenant', allowedActions: ['search.run'] }) },
      plannerFactory: (_initial: BookingCopilotTaskStateV2) => {
        const session = plannerFactory()
        return { next: async (_input: { turn: any; task: BookingCopilotTaskStateV2 }) => { errorPlannerCalls++; return session.next() } }
      },
    },
  })
  const errorTurn = { ...turn(errorTaskId), workspace: { ...workspace(), capabilities: { surface: 'tenant', allowedActions: ['search.run'] } } }
  const errorResponse = await fetch(`http://127.0.0.1:${errorServer.port}/a2a/booking-copilot/turn`, { method: 'POST', headers: { ...headers, authorization: `Bearer ${label}-key` }, body: JSON.stringify(errorTurn) })
  assert.equal(errorResponse.status, 200, `${label} keeps the committed SSE status while returning a typed error`)
  const errorBody = await errorResponse.text()
  assert.match(errorBody, /event: error/, `${label} never returns an empty SSE body`)
  assert.match(errorBody, new RegExp(`"code":"${expectedCode}"`), `${label} normalizes to the closed uppercase code`)
  assert.doesNotMatch(errorBody, /raw internal detail/, `${label} does not expose internal error text`)
  assert.doesNotMatch(errorBody, /event: operation/, `${label} emits no disallowed operation`)
  const actionRows = errorLedger.db.prepare("SELECT count(*) AS count FROM events WHERE kind = 'booking.copilot.v2.action.issued'").get() as { count: number }
  assert.equal(actionRows.count, 0, `${label} has zero disallowed operation side effect`)
  const afterErrorRows = errorLedger.countEvents()
  assert.equal(errorPlannerCalls, 1, `${label} calls planner once before durable typed error`)
  const errorReplay = await fetch(`http://127.0.0.1:${errorServer.port}/a2a/booking-copilot/turn`, { method: 'POST', headers: { ...headers, authorization: `Bearer ${label}-key` }, body: JSON.stringify(errorTurn) })
  assert.equal(errorReplay.status, 200, `${label} terminal typed error request replays as SSE, not HTTP conflict`)
  assert.equal(await errorReplay.text(), errorBody, `${label} typed error replay is byte-identical`)
  assert.equal(errorLedger.countEvents(), afterErrorRows, `${label} typed error replay appends zero ledger rows`)
  assert.equal(errorPlannerCalls, 1, `${label} typed error replay does not call planner again`)
  const errorConflict = await fetch(`http://127.0.0.1:${errorServer.port}/a2a/booking-copilot/turn`, { method: 'POST', headers: { ...headers, authorization: `Bearer ${label}-key` }, body: JSON.stringify({ ...errorTurn, request: { text: `${errorTurn.request.text} changed` } }) })
  assert.equal(errorConflict.status, 409, `${label} same turn identity with changed body remains a conflict`)
  await errorServer.close(); errorLedger.close(); rmSync(errorRoot, { recursive: true, force: true })
}

// A mixed v1+v2 deployment must not advertise v2 until the same trusted BFF
// principal/binding seam is supplied at composition time.
const mixedRoot = mkdtempSync(join(tmpdir(), 'gotry-booking-v2-mixed-startup-'))
const mixedLedger = ensureLedger(mixedRoot)
const mixedRuntimeV2 = new BookingCopilotTaskRuntimeV2(mixedLedger)
await assert.rejects(
  startBookingCopilotServer({ apiKey: 'mixed-v2-key', runtime: new BookingCopilotTaskRuntime(mixedLedger), plannerFactory: () => ({ next: async () => [] }), v2: { runtime: mixedRuntimeV2, plannerFactory: () => ({ next: async () => [] }) } }),
  /booking_copilot_v2_ingress_binding_required/,
  'mixed v1+v2 composition rejects unusable v2 instead of reporting partial readiness',
)
mixedLedger.close(); rmSync(mixedRoot, { recursive: true, force: true })
const v2OnlyRoot = mkdtempSync(join(tmpdir(), 'gotry-booking-v2-only-'))
const v2OnlyLedger = ensureLedger(v2OnlyRoot)
const v2OnlyRuntime = new BookingCopilotTaskRuntimeV2(v2OnlyLedger)
await assert.rejects(
  startBookingCopilotServer({ apiKey: 'v2-only-key', v2: { runtime: v2OnlyRuntime, plannerFactory: () => ({ next: async () => [] }) } }),
  /booking_copilot_v2_ingress_binding_required/,
  'v2-only server cannot start without trusted ingress binding and principal',
)
const v2OnlyServer = await startBookingCopilotServer({
  apiKey: 'v2-only-key',
  v2: {
    runtime: v2OnlyRuntime,
    principal: { subject: 'bff-v2-only', scope: 'booking:read' },
    ingressBinding: { bind: () => ({ taskId: 'task-v2-only', turnId: 'turn-v2-only', contextRef: 'ctx-v2-only', surface: 'tenant', allowedActions: [...BOOKING_READ_ACTION_KINDS_V2] }) },
    plannerFactory: () => ({ next: async () => [] }),
  },
})
const v2Health = await fetch(`http://127.0.0.1:${v2OnlyServer.port}/healthz`, { headers: { authorization: 'Bearer v2-only-key' } })
assert.equal(v2Health.status, 200)
assert.deepEqual(await v2Health.json(), { schemaVersion: 'booking.surface.v2', schemaSha256: BOOKING_SURFACE_SCHEMA_V2_SHA256, supportedSchemaVersions: ['booking.surface.v2'], status: 'ready' }, 'v2-only health reports ready only with trusted ingress configuration')
await v2OnlyServer.close()
v2OnlyLedger.close()
rmSync(v2OnlyRoot, { recursive: true, force: true })

runtime['ledger'].close()
awaitingRestart['ledger'].close()
reopened['ledger'].close()
serverRuntime['ledger'].close()
crashLedger.close(); reverseLedger.close()
terminalLedger.close()
forgedSourceRuntime['ledger'].close(); tamperLedger.close()
offerRuntime['ledger'].close()
rmSync(stateRoot, { recursive: true, force: true }); rmSync(serverRoot, { recursive: true, force: true })
rmSync(forgedSourceRoot, { recursive: true, force: true }); rmSync(tamperRoot, { recursive: true, force: true })
rmSync(crashRoot, { recursive: true, force: true }); rmSync(reverseRoot, { recursive: true, force: true })
rmSync(terminalRoot, { recursive: true, force: true })
rmSync(offerRoot, { recursive: true, force: true })
console.log('BOOKING COPILOT V2 RUNTIME PROOF: task scope, receipt binding, approval authority/one-time, recovery, ingress/SSE session OK')
