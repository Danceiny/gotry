import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensureLedger } from '../src/state-ledger.ts'
import {
  BookingCopilotTaskRuntime,
  bookingDigest,
  bookingTurnDigest,
} from '../src/booking-surface/runtime.ts'
import type {
  ActionReceipt,
  BookingReadAction,
  BookingWorkspaceSnapshot,
} from '../src/booking-surface/contracts.ts'
import type {
  BookingIntentCheckpoint,
  BookingIntentProjection,
} from '../src/booking-surface/booking-intent.ts'
import { validateBookingIntentProjection } from '../src/booking-surface/validation.ts'

const contextRef = 'ctx-intent-proof'
const allowedActions = [
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

function workspace(revision = 0): BookingWorkspaceSnapshot {
  return {
    schemaVersion: 'booking.surface',
    contextRef,
    surface: 'tenant',
    revision,
    locale: 'zh-CN',
    currency: 'AED',
    searchDraft: {},
    results: { status: 'idle' },
    visibleHotels: [],
    loadedOffers: [],
    shortlistedOfferRefs: [],
    capabilities: { surface: 'tenant', allowedActions: [...allowedActions] },
  }
}

function turn(taskId: string, requestText: string, revision = 0, snapshot = workspace(revision)) {
  return {
    schemaVersion: 'booking.surface' as const,
    kind: 'user.turn' as const,
    taskId,
    turnId: `${taskId}-turn-${revision}`,
    workspace: snapshot,
    request: { text: requestText },
  }
}

function action(actionId: string, revision = 0): BookingReadAction {
  return {
    schemaVersion: 'booking.surface',
    kind: 'search.run',
    actionId,
    contextRef,
    expectedRevision: revision,
    reason: 'Run the authoritative workspace search.',
    factRefs: [],
    input: {},
  }
}

const compositeIntent: BookingIntentProjection = {
  schemaVersion: 'booking.intent.v1',
  target: 'offers.compared',
  offerCriteria: {
    meals: { strength: 'must', value: ['breakfast'] },
    freeCancellation: { strength: 'must', value: true },
    targetCount: 3,
    sort: 'best_match',
  },
}

assert.equal(validateBookingIntentProjection(compositeIntent).ok, true, 'canonical composite offer intent is valid')
for (const invalid of [
  { ...compositeIntent, schemaVersion: 'booking.intent.v2' },
  { ...compositeIntent, target: 'book.now' },
  { ...compositeIntent, payment: { card: '4111 1111 1111 1111' } },
  { ...compositeIntent, offerCriteria: { targetCount: 0 } },
  { ...compositeIntent, offerCriteria: { meals: { strength: 'must', value: [] } } },
  { ...compositeIntent, offerCriteria: { meals: { strength: 'must', value: ['breakfast', 'breakfast'] } } },
  { ...compositeIntent, offerCriteria: { roomType: { strength: 'must', value: ['guest@example.com'] } } },
  { ...compositeIntent, offerCriteria: { roomType: { strength: 'must', value: ['supplier cost AED 10'] } } },
  { schemaVersion: 'booking.intent.v1', target: 'search.results', offerCriteria: { targetCount: 2 } },
  { schemaVersion: 'booking.intent.v1', target: 'results.refined', offerCriteria: { targetCount: 2 } },
  { schemaVersion: 'booking.intent.v1', target: 'hotel.focused', offerCriteria: { targetCount: 2 } },
  { schemaVersion: 'booking.intent.v1', target: 'hotel.selected', offerCriteria: { targetCount: 2 } },
  { schemaVersion: 'booking.intent.v1', target: 'order.observed', offerCriteria: { targetCount: 2 } },
]) {
  assert.equal(validateBookingIntentProjection(invalid).ok, false, `invalid intent is rejected: ${JSON.stringify(invalid)}`)
}

const root = mkdtempSync(join(tmpdir(), 'gotry-booking-intent-proof-'))
const taskId = 'task-intent-proof'
const requestText = '迪拜五星，给我三个含早免费取消的真实报价'
try {
  const firstLedger = ensureLedger(root)
  const firstRuntime = new BookingCopilotTaskRuntime(firstLedger, { contextRefFactory: () => contextRef })
  const initialTurn = turn(taskId, requestText)
  firstRuntime.startTask(initialTurn)
  assert.throws(
    () => (firstRuntime.issueOperation as unknown as (taskId: string, action: BookingReadAction) => unknown)(taskId, action('intent-missing-direct')),
    /booking_intent_required/,
    'the low-level runtime boundary cannot infer a final user waypoint from a shallow action',
  )
  firstRuntime.applyDecisionBatch(taskId, 'intent-first-operation', [{
    kind: 'operation',
    action: action('intent-search-run'),
    intent: compositeIntent,
  }])
  const pending = firstRuntime.resumeTask(taskId)
  assert.deepEqual(pending?.activeIntent?.projection, compositeIntent, 'the final user waypoint is bound to the first action')
  assert.equal(pending?.activeIntent?.sourceTurnId, initialTurn.turnId)
  assert.equal(pending?.activeIntent?.sourceRequestDigest, bookingTurnDigest(initialTurn))
  const actionPayloadText = (firstLedger.db.prepare("SELECT payload FROM events WHERE run_id = ? AND kind = 'booking.copilot.action.issued'").get(taskId) as { payload: string }).payload
  assert.equal(actionPayloadText.includes(requestText), false, 'the action checkpoint stores no raw user request')
  firstLedger.close()

  const receiptWorkspace: BookingWorkspaceSnapshot = {
    ...workspace(1),
    results: { status: 'ready', searchSessionRef: 'search-intent-1', resultCount: 1 },
    visibleHotels: [{ hotelRef: 'hotel-intent-1', name: 'Intent Hotel', factRefs: [] }],
  }
  const receipt: ActionReceipt = {
    schemaVersion: 'booking.surface',
    kind: 'action.receipt',
    actionId: 'intent-search-run',
    contextRef,
    status: 'applied',
    revision: 1,
    observation: { kind: 'search.state', searchSessionRef: 'search-intent-1', resultCount: 1 },
    resultContract: {
      outcome: 'complete',
      hardCriteriaMet: true,
      factRefs: [],
      gapCodes: [],
      blockers: [],
      relaxationsApplied: [],
    },
  }

  const secondLedger = ensureLedger(root)
  const secondRuntime = new BookingCopilotTaskRuntime(secondLedger, { contextRefFactory: () => contextRef })
  const replayedPending = secondRuntime.resumeTask(taskId)
  assert.deepEqual(replayedPending?.activeIntent?.projection, compositeIntent, 'process restart replays the exact semantic goal')
  const afterReceipt = secondRuntime.continueWithReceipt({
    schemaVersion: 'booking.surface',
    kind: 'action.receipt.continuation',
    taskId,
    workspace: receiptWorkspace,
    receipt,
  })
  assert.deepEqual(afterReceipt.activeIntent?.projection, compositeIntent, 'an intermediate receipt cannot shorten the user goal')
  assert.equal(afterReceipt.lastCompletedAction?.kind, 'search.run')
  assert.throws(() => secondRuntime.applyDecisionBatch(taskId, 'intent-missing-operation', [{
    kind: 'operation',
    action: {
      schemaVersion: 'booking.surface',
      kind: 'offers.query',
      actionId: 'intent-missing-query',
      contextRef,
      expectedRevision: 1,
      reason: 'Attempt to omit the durable goal.',
      factRefs: [],
      input: { hotelRefs: ['hotel-intent-1'], criteria: compositeIntent.offerCriteria! },
    },
  } as never]), /invalid_booking_intent/, 'a model-facing operation cannot rely on runtime inference when intent is missing')
  assert.throws(() => secondRuntime.applyDecisionBatch(taskId, 'intent-weakened-operation', [{
    kind: 'operation',
    action: {
      schemaVersion: 'booking.surface',
      kind: 'offers.query',
      actionId: 'intent-weakened-query',
      contextRef,
      expectedRevision: 1,
      reason: 'Attempt to execute weaker criteria than the durable goal.',
      factRefs: [],
      input: { hotelRefs: ['hotel-intent-1'], criteria: { targetCount: 1 } },
    },
    intent: compositeIntent,
  }]), /action_intent_mismatch/, 'a later action cannot execute weaker criteria than the durable semantic goal')
  secondRuntime.applyDecisionBatch(taskId, 'intent-next-operation', [{
    kind: 'operation',
    action: {
      schemaVersion: 'booking.surface',
      kind: 'offers.query',
      actionId: 'intent-offers-query',
      contextRef,
      expectedRevision: 1,
      reason: 'Load authoritative offers for the visible candidate.',
      factRefs: [],
      input: { hotelRefs: ['hotel-intent-1'], criteria: compositeIntent.offerCriteria! },
    },
    intent: compositeIntent,
  }])
  assert.deepEqual(secondRuntime.resumeTask(taskId)?.activeIntent?.projection, compositeIntent, 'a later action reuses the durable goal without model prose')
  assert.throws(() => secondRuntime.applyDecisionBatch(taskId, 'intent-mutated-operation', [{
    kind: 'operation',
    action: {
      schemaVersion: 'booking.surface',
      kind: 'offers.query',
      actionId: 'intent-mutated-query',
      contextRef,
      expectedRevision: 1,
      reason: 'Attempt to mutate the goal.',
      factRefs: [],
      input: { hotelRefs: ['hotel-intent-1'], criteria: { targetCount: 1 } },
    },
    intent: { ...compositeIntent, offerCriteria: { targetCount: 1 } },
  }]), /receipt_required|intent_mutation_forbidden/, 'the model cannot replace an in-flight semantic goal')
  secondLedger.close()
} finally {
  rmSync(root, { recursive: true, force: true })
}

function tamperIntent(
  name: string,
  mutate: (checkpoint: BookingIntentCheckpoint) => BookingIntentCheckpoint,
): void {
  const tamperRoot = mkdtempSync(join(tmpdir(), `gotry-booking-intent-${name}-`))
  const tamperTaskId = `task-intent-${name}`
  try {
    const ledger = ensureLedger(tamperRoot)
    const runtime = new BookingCopilotTaskRuntime(ledger, { contextRefFactory: () => contextRef })
    runtime.startTask(turn(tamperTaskId, 'find hotels'))
    runtime.applyDecisionBatch(tamperTaskId, `${name}-operation`, [{
      kind: 'operation',
      action: action(`${name}-action`),
      intent: compositeIntent,
    }])
    const row = ledger.db.prepare("SELECT seq, payload FROM events WHERE run_id = ? AND kind = 'booking.copilot.action.issued'").get(tamperTaskId) as { seq: number; payload: string }
    const payload = JSON.parse(row.payload) as { intent: BookingIntentCheckpoint }
    payload.intent = mutate(payload.intent)
    ledger.db.prepare('UPDATE events SET payload = ? WHERE seq = ?').run(JSON.stringify(payload), row.seq)
    assert.throws(() => runtime.resumeTask(tamperTaskId), new RegExp(`ledger_corrupt:${tamperTaskId}:intent`), `${name} intent tampering is fail-closed`)
    ledger.close()
  } finally {
    rmSync(tamperRoot, { recursive: true, force: true })
  }
}

tamperIntent('projection', (checkpoint) => ({
  ...checkpoint,
  projection: { ...checkpoint.projection, target: 'search.results' },
}))
tamperIntent('digest', (checkpoint) => ({ ...checkpoint, intentDigest: '0'.repeat(64) }))
tamperIntent('source-turn', (checkpoint) => {
  const base = { ...checkpoint, sourceTurnId: 'forged-turn' }
  const { intentDigest: _old, ...digestInput } = base
  return { ...base, intentDigest: bookingDigest(digestInput) }
})
tamperIntent('source-request', (checkpoint) => {
  const base = { ...checkpoint, sourceRequestDigest: 'f'.repeat(64) }
  const { intentDigest: _old, ...digestInput } = base
  return { ...base, intentDigest: bookingDigest(digestInput) }
})
tamperIntent('task-graft', (checkpoint) => {
  const base = { ...checkpoint, taskId: 'task-from-another-ledger' }
  const { intentDigest: _old, ...digestInput } = base
  return { ...base, intentDigest: bookingDigest(digestInput) }
})
tamperIntent('context-graft', (checkpoint) => {
  const base = { ...checkpoint, contextRef: 'ctx-from-another-actor' }
  const { intentDigest: _old, ...digestInput } = base
  return { ...base, intentDigest: bookingDigest(digestInput) }
})

// Expand compatibility: old ACTION rows without a typed intent remain
// additive-readable, but their action/receipt tail is safely replanned rather
// than left pending or allowed to terminalize a task.
{
  const legacyRoot = mkdtempSync(join(tmpdir(), 'gotry-booking-intent-legacy-'))
  const legacyTaskId = 'task-intent-legacy'
  try {
    const ledger = ensureLedger(legacyRoot)
    const runtime = new BookingCopilotTaskRuntime(ledger, { contextRefFactory: () => contextRef })
    runtime.startTask(turn(legacyTaskId, 'find hotels'))
    runtime.issueOperation(legacyTaskId, action('legacy-intent-action'), { schemaVersion: 'booking.intent.v1', target: 'search.results' })
    const receiptWorkspace: BookingWorkspaceSnapshot = {
      ...workspace(1),
      results: { status: 'ready', searchSessionRef: 'legacy-search-1', resultCount: 1 },
    }
    runtime.continueWithReceipt({
      schemaVersion: 'booking.surface',
      kind: 'action.receipt.continuation',
      taskId: legacyTaskId,
      workspace: receiptWorkspace,
      receipt: {
        schemaVersion: 'booking.surface',
        kind: 'action.receipt',
        actionId: 'legacy-intent-action',
        contextRef,
        status: 'applied',
        revision: 1,
        observation: { kind: 'search.state', searchSessionRef: 'legacy-search-1', resultCount: 1 },
        resultContract: { outcome: 'complete', hardCriteriaMet: true, factRefs: [], gapCodes: [], blockers: [], relaxationsApplied: [] },
      },
    })
    const row = ledger.db.prepare("SELECT seq, payload FROM events WHERE run_id = ? AND kind = 'booking.copilot.action.issued'").get(legacyTaskId) as { seq: number; payload: string }
    const payload = JSON.parse(row.payload) as Record<string, unknown>
    delete payload.intent
    ledger.db.prepare('UPDATE events SET payload = ? WHERE seq = ?').run(JSON.stringify(payload), row.seq)
    ledger.close()

    const replayLedger = ensureLedger(legacyRoot)
    const replayRuntime = new BookingCopilotTaskRuntime(replayLedger, { contextRefFactory: () => contextRef })
    const replayed = replayRuntime.resumeTask(legacyTaskId)
    assert.equal(replayed?.pendingAction, undefined, 'legacy action/receipt replay must not remain pending')
    assert.equal(replayed?.activeIntent, undefined, 'legacy action replay does not invent a later user goal')
    assert.equal(replayed?.lastReceipt, undefined, 'legacy receipt replay does not become current evidence')
    assert.equal(replayed?.replayUpgradeRequired, true, 'legacy action/receipt replay requires a fresh turn anchor')
    assert.equal(replayed?.phase, 'planning', 'legacy action/receipt replay remains replannable, not terminal')
    assert.throws(() => (replayRuntime.issueOperation as unknown as (taskId: string, candidate: ReturnType<typeof action>) => unknown)(legacyTaskId, action('legacy-missing-intent')), /booking_intent_required/, 'untyped legacy two-argument call still fails closed at runtime')
    replayLedger.close()
  } finally {
    rmSync(legacyRoot, { recursive: true, force: true })
  }
}

// A legal action kind paired with an overshooting intent is rejected at issue
// time and from a tampered replay row using the same ordinal table.
{
  const pathRoot = mkdtempSync(join(tmpdir(), 'gotry-booking-intent-path-'))
  try {
    const ledger = ensureLedger(pathRoot)
    const runtime = new BookingCopilotTaskRuntime(ledger, { contextRefFactory: () => contextRef })
    const pathTaskId = 'task-intent-path'
    runtime.startTask(turn(pathTaskId, 'search'))
    assert.throws(() => runtime.applyDecisionBatch(pathTaskId, 'invalid-search-offer-criteria', [{
      kind: 'operation', action: action('invalid-search-offer-criteria'),
      intent: { schemaVersion: 'booking.intent.v1', target: 'search.results', offerCriteria: { targetCount: 2 } },
    }]), /invalid_booking_intent/, 'same-turn intent schema rejects offer criteria on a search waypoint')
    assert.throws(() => runtime.applyDecisionBatch(pathTaskId, 'overshoot-at-issue', [{
      kind: 'operation',
      action: { ...action('overshoot-check'), kind: 'offer.check' as const, input: { offerRef: 'offer-path', offerVersionRef: 'offer-path:v1' } },
      intent: { schemaVersion: 'booking.intent.v1', target: 'search.results' },
    }]), /action_intent_mismatch/, 'a legal action cannot overshoot its durable intent target')
    runtime.applyDecisionBatch(pathTaskId, 'path-valid-prefix', [{
      kind: 'operation',
      action: action('path-search-run'),
      intent: { schemaVersion: 'booking.intent.v1', target: 'offers.compared', offerCriteria: { targetCount: 3 } },
    }])
    const row = ledger.db.prepare("SELECT seq, payload FROM events WHERE run_id = ? AND kind = 'booking.copilot.action.issued'").get(pathTaskId) as { seq: number; payload: string }
    const payload = JSON.parse(row.payload) as { intent: BookingIntentCheckpoint }
    payload.intent = { ...payload.intent, projection: { ...payload.intent.projection, target: 'search.results' } }
    ledger.db.prepare('UPDATE events SET payload = ? WHERE seq = ?').run(JSON.stringify(payload), row.seq)
    assert.throws(() => runtime.resumeTask(pathTaskId), new RegExp(`ledger_corrupt:${pathTaskId}:intent`), 'the same target/action path rule is enforced during replay')
    ledger.close()
  } finally {
    rmSync(pathRoot, { recursive: true, force: true })
  }
}

// Existing-order observation is an independent waypoint. Preparing Checkout
// belongs to the current booking journey; after user authorization/Book a new
// trusted order context starts observation.
{
  const checkoutRoot = mkdtempSync(join(tmpdir(), 'gotry-booking-intent-checkout-'))
  try {
    const ledger = ensureLedger(checkoutRoot)
    const runtime = new BookingCopilotTaskRuntime(ledger, { contextRefFactory: () => contextRef })
    const checkoutTaskId = 'task-intent-order-observed'
    runtime.startTask(turn(checkoutTaskId, 'observe an existing order'))
    assert.throws(() => runtime.applyDecisionBatch(checkoutTaskId, 'order-observed-checkout', [{
      kind: 'operation',
      action: {
        schemaVersion: 'booking.surface', kind: 'checkout.prepare', actionId: 'order-observed-checkout-action', contextRef,
        expectedRevision: 0, reason: 'Prepare checkout before observing order.', factRefs: [],
        input: { offerRef: 'offer-order-1', offerVersionRef: 'offer-order-1:v1', verifiedOfferRef: 'verified-order-1' },
      },
      intent: { schemaVersion: 'booking.intent.v1', target: 'order.observed' },
    }]), /action_intent_mismatch/, 'checkout.prepare cannot advance an independent order.observed intent')
    ledger.close()
  } finally {
    rmSync(checkoutRoot, { recursive: true, force: true })
  }
}

// A projection can name only a waypoint supported by the current surface.
{
  const narrowRoot = mkdtempSync(join(tmpdir(), 'gotry-booking-intent-narrow-'))
  try {
    const ledger = ensureLedger(narrowRoot)
    const runtime = new BookingCopilotTaskRuntime(ledger, { contextRefFactory: () => contextRef })
    const narrowWorkspace: BookingWorkspaceSnapshot = {
      ...workspace(),
      capabilities: { surface: 'tenant', allowedActions: ['search.run'] },
    }
    runtime.startTask(turn('task-intent-narrow', 'find and compare offers', 0, narrowWorkspace))
    assert.throws(() => runtime.applyDecisionBatch('task-intent-narrow', 'narrow-operation', [{
      kind: 'operation',
      action: action('narrow-action'),
      intent: compositeIntent,
    }]), /intent_target_unsupported/, 'intent cannot expand the surface capability allowlist')
    ledger.close()
  } finally {
    rmSync(narrowRoot, { recursive: true, force: true })
  }
}

// Count semantics are part of the durable goal, not advisory model prose.
{
  const countRoot = mkdtempSync(join(tmpdir(), 'gotry-booking-intent-count-'))
  try {
    const ledger = ensureLedger(countRoot)
    const runtime = new BookingCopilotTaskRuntime(ledger, { contextRefFactory: () => contextRef })
    const countWorkspace: BookingWorkspaceSnapshot = {
      ...workspace(),
      loadedOffers: [{ offerRef: 'offer-count-1', offerVersionRef: 'offer-count-1:v1', hotelRef: 'hotel-count-1', evidenceLevel: 'rate_loaded', factRefs: [] }],
      capabilities: { surface: 'tenant', allowedActions: ['offers.compare'] },
    }
    runtime.startTask(turn('task-intent-count', 'compare three offers', 0, countWorkspace))
    assert.throws(() => runtime.applyDecisionBatch('task-intent-count', 'count-mismatch-operation', [{
      kind: 'operation',
      action: {
        schemaVersion: 'booking.surface',
        kind: 'offers.compare',
        actionId: 'count-mismatch-action',
        contextRef,
        expectedRevision: 0,
        reason: 'Attempt to compare fewer offers than requested.',
        factRefs: [],
        input: { offerRefs: ['offer-count-1'], requestedCount: 1 },
      },
      intent: {
        schemaVersion: 'booking.intent.v1',
        target: 'offers.compared',
        offerCriteria: { targetCount: 3 },
      },
    }]), /action_intent_mismatch/, 'requestedCount cannot be weakened below the durable comparison target')
    ledger.close()
  } finally {
    rmSync(countRoot, { recursive: true, force: true })
  }
}

console.log('BOOKING COPILOT INTENT PROOF: canonical validation/persistence/restart/tamper/legacy/capability OK')
