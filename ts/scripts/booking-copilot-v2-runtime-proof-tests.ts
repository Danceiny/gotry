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
import { BOOKING_READ_ACTION_KINDS_V2, BOOKING_SURFACE_SCHEMA_VERSION_V2, type BookingWorkspaceSnapshotV2, type RelaxationApprovalV2 } from '../src/booking-surface/contracts-v2.ts'
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
  schemaVersion: 'booking.surface.v2', kind: 'user.turn.ingress', taskId: undefined, turnId: 'ingress-no-task', surfaceHint: 'tenant',
  workspace: { schemaVersion: 'booking.surface.v2', revision: 0, locale: 'en-US', currency: 'AED', searchDraft: {}, results: { status: 'idle' }, visibleHotels: [], loadedOffers: [], shortlistedOfferRefs: [] },
  request: { text: 'find hotels in Dubai' },
} as never), /invalid_planner_turn/)
assert.equal(directIngressLedger.countEvents(), directIngressBefore, 'missing ingress taskId has no direct runtime ledger side effects')
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
const offerTask = offerRuntime.startTask(turn('task-offer-target'))
offerRuntime.issueOperation(offerTask.taskId, { ...action('offer-action'), kind: 'offer.check', input: { offerRef: 'offer-a' } })
const offerReceipt = offerRuntime.withReceiptDigest({ ...receipt, actionId: 'offer-action', observation: { kind: 'offer.availability', offerRef: 'offer-b', available: true, changedFactRefs: [], gapCodes: [] }, resultContract: { ...receipt.resultContract, blockers: [], gapCodes: [] } })
assert.throws(() => offerRuntime.continueWithReceipt({ schemaVersion: 'booking.surface.v2', kind: 'action.receipt.continuation', taskId: offerTask.taskId, workspace: workspace(1), receipt: offerReceipt }), /receipt_target_mismatch/)
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
  v2: { runtime: serverRuntime,
  plannerFactory: (initial: BookingCopilotTaskStateV2) => { factoryCalls++; return { next: async ({ task: current }) => { plannerCalls++; const decision: BookingPlannerDecisionV2 = { kind: 'operation', action: { ...action(`server-action-${plannerCalls}`, current.revision), contextRef: current.contextRef } }; return [decision] } } },
  },
})
const endpoint = `http://127.0.0.1:${server.port}/a2a/booking-copilot/turn`
const headers = { authorization: 'Bearer v2-server-key', 'content-type': 'application/json', 'x-booking-surface-version': BOOKING_SURFACE_SCHEMA_VERSION_V2, 'x-booking-surface-schema-sha256': BOOKING_SURFACE_SCHEMA_V2_SHA256 }
const ingress = { schemaVersion: 'booking.surface.v2', kind: 'user.turn.ingress', taskId: 'task-server', turnId: 'ingress-turn-1', surfaceHint: 'tenant', workspace: { schemaVersion: 'booking.surface.v2', revision: 0, locale: 'en-US', currency: 'AED', searchDraft: {}, results: { status: 'idle' }, visibleHotels: [], loadedOffers: [], shortlistedOfferRefs: [] }, request: { text: 'find hotels in Dubai' } }
const missingTurnLedgerEvents = serverRuntime['ledger'].countEvents()
const missingIngress = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify({ ...ingress, turnId: undefined }) })
assert.equal(missingIngress.status, 400, 'missing ingress turnId is rejected at HTTP schema boundary')
const missingUser = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify({ ...turn('missing-user'), turnId: undefined }) })
assert.equal(missingUser.status, 400, 'missing user turnId is rejected at HTTP schema boundary')
const missingIngressTask = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify({ ...ingress, taskId: undefined }) })
assert.equal(missingIngressTask.status, 400, 'missing ingress taskId is rejected at HTTP schema boundary')
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
const second = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(receiptTurn) })
assert.equal(second.status, 200)
const secondBody = await second.text()
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
terminalRuntime.startTask(terminalTurn)
assert.equal(terminalLedger.countEvents(), terminalCount, 'terminal exact replay does not append a turn')
assert.throws(() => terminalRuntime.startTask({ ...terminalTurn, turnId: 'terminal-new-turn' }), /task_terminal/)
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
const v2OnlyRoot = mkdtempSync(join(tmpdir(), 'gotry-booking-v2-only-'))
const v2OnlyLedger = ensureLedger(v2OnlyRoot)
const v2OnlyServer = await startBookingCopilotServer({ apiKey: 'v2-only-key', runtime: new BookingCopilotTaskRuntime(v2OnlyLedger), plannerFactory: () => ({ next: async () => [] }), v2: { runtime: new BookingCopilotTaskRuntimeV2(v2OnlyLedger), plannerFactory: () => ({ next: async () => [] }) } })
const v2Health = await fetch(`http://127.0.0.1:${v2OnlyServer.port}/healthz`, { headers: { authorization: 'Bearer v2-only-key' } })
assert.equal(v2Health.status, 200)
assert.deepEqual(await v2Health.json(), { schemaVersion: 'booking.surface.v1', schemaSha256: BOOKING_SURFACE_SCHEMA_SHA256, supportedSchemaVersions: ['booking.surface.v1', 'booking.surface.v2'], status: 'ready' }, 'dual-protocol health reports both active capabilities')
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
