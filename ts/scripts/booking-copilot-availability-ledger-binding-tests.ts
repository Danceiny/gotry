import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensureLedger } from '../src/state-ledger.ts'
import { BookingCopilotTaskRuntimeV2, bookingV2Digest } from '../src/booking-surface/runtime-v2.ts'
import type { ActionReceiptV2, BookingWorkspaceSnapshotV2 } from '../src/booking-surface/contracts-v2.ts'

const workspace = (revision: number): BookingWorkspaceSnapshotV2 => ({
  schemaVersion: 'booking.surface.v2', contextRef: 'ctx-ledger-binding', surface: 'tenant', revision,
  locale: 'en-US', currency: 'AED', searchDraft: {}, results: { status: 'idle' },
  visibleHotels: [{ hotelRef: 'h1', name: 'H1', factRefs: [] }, { hotelRef: 'h2', name: 'H2', factRefs: [] }],
  loadedOffers: [{ offerRef: 'o1', offerVersionRef: 'o1:v1', hotelRef: 'h1', evidenceLevel: 'rate_loaded', factRefs: [] }, { offerRef: 'o2', offerVersionRef: 'o2:v1', hotelRef: 'h2', evidenceLevel: 'rate_loaded', factRefs: [] }],
  shortlistedOfferRefs: ['o1', 'o2'], capabilities: { surface: 'tenant', allowedActions: ['offers.query', 'offer.check'] },
})

const offersReceipt = (actionId: string, revision: number): ActionReceiptV2 => ({
  schemaVersion: 'booking.surface.v2', kind: 'action.receipt', actionId, contextRef: 'ctx-ledger-binding', status: 'applied', revision,
  observation: { kind: 'offers.state', hotelRefs: ['h1'], offerRefs: ['o1'], loadedHotelCount: 1 },
  resultContract: { outcome: 'complete', hardCriteriaMet: true, factRefs: [], gapCodes: [], blockers: [], relaxationsApplied: [] },
})

const checkReceipt = (actionId: string, revision: number): ActionReceiptV2 => ({
  schemaVersion: 'booking.surface.v2', kind: 'action.receipt', actionId, contextRef: 'ctx-ledger-binding', status: 'unavailable', revision,
  observation: { kind: 'offer.availability', offerRef: 'o1', checkedOfferVersionRef: 'o1:v1', available: false, changedFactRefs: [], gapCodes: [] },
  resultContract: { outcome: 'empty', hardCriteriaMet: false, factRefs: [], gapCodes: [], blockers: [], relaxationsApplied: [] },
})

type Fixture = { root: string; ledger: ReturnType<typeof ensureLedger>; task: string }

function fixture(stage: 'action' | 'receipt'): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'gotry-availability-ledger-binding-'))
  const ledger = ensureLedger(root)
  const runtime = new BookingCopilotTaskRuntimeV2(ledger, { contextRefFactory: () => 'ctx-ledger-binding' })
  const task = 'ledger-binding-task'
  runtime.startTask({ schemaVersion: 'booking.surface.v2', kind: 'user.turn', taskId: task, turnId: 'turn-1', workspace: workspace(0), request: { text: 'find rates' } })
  const query = { schemaVersion: 'booking.surface.v2' as const, kind: 'offers.query' as const, actionId: 'query-1', contextRef: 'ctx-ledger-binding', expectedRevision: 0, reason: 'load offers', factRefs: [], input: { hotelRefs: ['h1'], criteria: {} } }
  runtime.issueOperation(task, query)
  runtime.continueWithReceipt({ schemaVersion: 'booking.surface.v2', kind: 'action.receipt.continuation', taskId: task, workspace: workspace(1), receipt: offersReceipt('query-1', 1) })
  const check = { schemaVersion: 'booking.surface.v2' as const, kind: 'offer.check' as const, actionId: 'check-1', contextRef: 'ctx-ledger-binding', expectedRevision: 1, reason: 'check', factRefs: [], input: { offerRef: 'o1', offerVersionRef: 'o1:v1' } }
  runtime.issueOperation(task, check)
  if (stage === 'receipt') runtime.continueWithReceipt({ schemaVersion: 'booking.surface.v2', kind: 'action.receipt.continuation', taskId: task, workspace: { ...workspace(2), shortlistedOfferRefs: ['o2'], selectedOfferRef: undefined, verifiedOffer: undefined }, receipt: checkReceipt('check-1', 2) })
  ledger.close()
  return { root, ledger, task }
}

function rewrite(root: string, kind: string, mutate: (payload: Record<string, any>) => void): void {
  const ledger = ensureLedger(root)
  const row = ledger.db.prepare('SELECT seq, payload FROM events WHERE run_id = ? AND kind = ? ORDER BY seq DESC LIMIT 1').get('ledger-binding-task', kind) as { seq: number; payload: string } | undefined
  assert.ok(row)
  const payload = JSON.parse(row.payload) as Record<string, any>
  mutate(payload)
  ledger.db.prepare('UPDATE events SET payload = ? WHERE seq = ?').run(JSON.stringify(payload), row.seq)
  ledger.close()
}

function assertCorrupt(root: string, label: string): void {
  const ledger = ensureLedger(root)
  const runtime = new BookingCopilotTaskRuntimeV2(ledger, { contextRefFactory: () => 'ctx-ledger-binding' })
  assert.throws(() => runtime.resumeTask('ledger-binding-task'), /ledger_corrupt:ledger-binding-task/, label)
  ledger.close()
}

// The untouched durable sequence is replayable after reopening the ledger.
{
  const fixtureState = fixture('action')
  const ledger = ensureLedger(fixtureState.root)
  assert.doesNotThrow(() => new BookingCopilotTaskRuntimeV2(ledger).resumeTask(fixtureState.task))
  ledger.close(); rmSync(fixtureState.root, { recursive: true, force: true })
}

for (const [label, mutate] of [
  ['candidate digest', (payload: Record<string, any>) => { payload.availability.candidateSetDigest = 'f'.repeat(64); payload.availabilityDigest = bookingV2Digest(payload.availability) }],
  ['offer set digest', (payload: Record<string, any>) => { payload.availability.hotels.h1.currentGeneration.offerSetDigest = 'e'.repeat(64); payload.availabilityDigest = bookingV2Digest(payload.availability) }],
  ['source receipt digest', (payload: Record<string, any>) => { payload.availability.hotels.h1.currentGeneration.source.receiptDigest = 'd'.repeat(64); payload.availabilityDigest = bookingV2Digest(payload.availability) }],
  ['active ordinal', (payload: Record<string, any>) => { payload.availability.activeHotelOrdinal = 1; payload.availabilityDigest = bookingV2Digest(payload.availability) }],
  ['fake terminal', (payload: Record<string, any>) => { payload.availability.terminal = { code: 'availability_confirmed', hotelRefs: ['h1', 'h2'], reason: 'confirmed', evidence: 'conclusive' }; payload.availability.availabilityPhase = 'terminal'; payload.availabilityDigest = bookingV2Digest(payload.availability) }],
] as const) {
  const fixtureState = fixture('action')
  rewrite(fixtureState.root, 'booking.copilot.v2.action.issued', mutate)
  assertCorrupt(fixtureState.root, label)
  rmSync(fixtureState.root, { recursive: true, force: true })
}

// A digest mismatch must be rejected before any legacy/normalized availability
// migration can make the payload appear coherent.
{
  const fixtureState = fixture('action')
  rewrite(fixtureState.root, 'booking.copilot.v2.action.issued', (payload) => { payload.availability.activeHotelOrdinal = 1 })
  assertCorrupt(fixtureState.root, 'raw ACTION availability digest mismatch')
  rmSync(fixtureState.root, { recursive: true, force: true })
}
{
  const fixtureState = fixture('receipt')
  rewrite(fixtureState.root, 'booking.copilot.v2.receipt.observed', (payload) => { payload.availability.activeHotelOrdinal = 1 })
  assertCorrupt(fixtureState.root, 'raw RECEIPT availability digest mismatch')
  rmSync(fixtureState.root, { recursive: true, force: true })
}

// A forged action can be structurally valid and re-digested, but cannot change
// the transition that the prior state and workspace authorize.
{
  const fixtureState = fixture('action')
  rewrite(fixtureState.root, 'booking.copilot.v2.action.issued', (payload) => {
    payload.action.input.offerRef = 'o2'
    const { actionDigest: _ignored, ...base } = payload.action
    payload.action.actionDigest = bookingV2Digest(base)
  })
  assertCorrupt(fixtureState.root, 'wrong action transition')
  rmSync(fixtureState.root, { recursive: true, force: true })
}

// The receipt shape and canonical receipt digest can both be valid while the
// availability transition is forged; replay must still derive the mismatch.
{
  const fixtureState = fixture('receipt')
  const runtimeLedger = ensureLedger(fixtureState.root)
  const runtime = new BookingCopilotTaskRuntimeV2(runtimeLedger)
  assert.deepEqual(runtime.resumeTask(fixtureState.task)?.availability.criteria, {}, 'recovery retains the canonical offer criteria after restart')
  const wrongDetour = { schemaVersion: 'booking.surface.v2' as const, kind: 'search.run' as const, actionId: 'detour', contextRef: 'ctx-ledger-binding', expectedRevision: 2, reason: 'detour', factRefs: [], input: {} }
  assert.throws(() => runtime.applyDecisionBatch(fixtureState.task, 'detour-batch', [{ kind: 'operation', action: wrongDetour }]), /availability_operation_incompatible/)
  runtimeLedger.close()
  rmSync(fixtureState.root, { recursive: true, force: true })
}

{
  const fixtureState = fixture('receipt')
  rewrite(fixtureState.root, 'booking.copilot.v2.receipt.observed', (payload) => {
    payload.receipt.status = 'applied'
    payload.receiptDigest = bookingV2Digest(payload.receipt)
  })
  assertCorrupt(fixtureState.root, 'wrong receipt transition')
  rmSync(fixtureState.root, { recursive: true, force: true })
}

console.log('BOOKING COPILOT AVAILABILITY LEDGER BINDING: exact replay and candidate/generation/source/ordinal/terminal/action/receipt tamper rejection OK')
