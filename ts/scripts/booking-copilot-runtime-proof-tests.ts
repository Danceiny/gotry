import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ensureLedger } from '../src/state-ledger.ts'
import {
  BookingCopilotTaskRuntime,
  bookingDigest,
  type BookingApprovalState,
  type BookingCopilotTaskState,
  type BookingPlannerDecision,
} from '../src/booking-surface/runtime.ts'
import { startBookingCopilotServer } from '../src/booking-surface/server.ts'
import { BOOKING_COPILOT_MAX_OPERATIONS, BOOKING_FULL_JOURNEY_ACTION_KINDS, BOOKING_READ_ACTION_KINDS, BOOKING_SURFACE_SCHEMA_SHA256, BOOKING_SURFACE_SCHEMA_VERSION, type ActionReceipt, type BookingReadActionKind, type BookingSurface, type BookingSurfaceEvent, type BookingWorkspaceSnapshot, type RelaxationApproval, type VerifiedOfferCapability } from '../src/booking-surface/contracts.ts'
import { validateBookingSurface } from '../src/booking-surface/validation.ts'

const stateRoot = mkdtempSync(join(tmpdir(), 'gotry-booking-v2-runtime-'))
const workspace = (revision = 0): BookingWorkspaceSnapshot => ({
  schemaVersion: 'booking.surface', contextRef: 'ctx-v2', surface: 'tenant', revision,
  locale: 'en-US', currency: 'AED', searchDraft: {}, results: { status: 'idle' },
  visibleHotels: [], loadedOffers: [], shortlistedOfferRefs: [],
  capabilities: { surface: 'tenant', allowedActions: [...BOOKING_FULL_JOURNEY_ACTION_KINDS] },
})
const loadedOffer = (offerRef: string, hotelRef: string, offerVersionRef = `${offerRef}:v1`) => ({ offerRef, offerVersionRef, hotelRef, evidenceLevel: 'rate_loaded' as const, factRefs: [] })
const verifiedCapability = (offerRef: string, offerVersionRef = `${offerRef}:v1`, expiresAt = '2026-09-01T10:30:00.000Z'): VerifiedOfferCapability => ({ offerRef, offerVersionRef, verifiedOfferRef: `verified-${offerRef}`, expiresAt })
const availabilityObservation = (offerRef: string, checkedOfferVersionRef = `${offerRef}:v1`, available = false, currentOfferVersionRef?: string): ActionReceipt['observation'] => ({ kind: 'offer.availability', offerRef, checkedOfferVersionRef, currentOfferVersionRef: available ? (currentOfferVersionRef ?? checkedOfferVersionRef) : undefined, available, changedFactRefs: [], gapCodes: [] })
const oldWorkspaceDigest = (value: Record<string, unknown>): string => {
  const { contextRef: _contextRef, ...withoutContext } = value
  return bookingDigest(withoutContext)
}
const oldWorkspaceSemanticDigest = (value: Record<string, unknown>): string => {
  const { contextRef: _contextRef, revision: _revision, ...semantic } = value
  return bookingDigest(semantic)
}
const legacyWorkspace = (value: BookingWorkspaceSnapshot, verifiedOfferRef?: string): Record<string, unknown> => {
  const workspaceValue = structuredClone(value) as unknown as Record<string, unknown>
  const loadedOffers = Array.isArray(workspaceValue.loadedOffers) ? workspaceValue.loadedOffers : []
  workspaceValue.loadedOffers = loadedOffers.map((loaded) => {
    const oldOffer = { ...(loaded as Record<string, unknown>) }
    delete oldOffer.offerVersionRef
    return oldOffer
  })
  delete workspaceValue.verifiedOffer
  if (verifiedOfferRef !== undefined) workspaceValue.verifiedOfferRef = verifiedOfferRef
  return workspaceValue
}
const legacyAvailability = (value: Record<string, unknown>, workspaceDigest?: string): Record<string, unknown> => {
  const availability = structuredClone(value)
  const hotels = availability.hotels
  if (hotels && typeof hotels === 'object' && !Array.isArray(hotels)) {
    for (const hotel of Object.values(hotels as Record<string, unknown>)) {
      if (!hotel || typeof hotel !== 'object' || Array.isArray(hotel)) continue
      const oldHotel = hotel as Record<string, unknown>
      delete oldHotel.tombstonedOfferVersionRefs
      const generation = oldHotel.currentGeneration
      if (workspaceDigest && generation && typeof generation === 'object' && !Array.isArray(generation)) {
        const source = (generation as Record<string, unknown>).source
        if (source && typeof source === 'object' && !Array.isArray(source) && (source as Record<string, unknown>).kind === 'workspace_snapshot') (source as Record<string, unknown>).workspaceDigest = workspaceDigest
      }
    }
  }
  if (Array.isArray(availability.attempts)) {
    availability.attempts = availability.attempts.map((attempt) => {
      if (!attempt || typeof attempt !== 'object' || Array.isArray(attempt)) return attempt
      const oldAttempt = { ...(attempt as Record<string, unknown>) }
      delete oldAttempt.offerVersionRef
      return oldAttempt
    })
  }
  return availability
}
const stripLegacyReceipt = (value: ActionReceipt): Record<string, unknown> => {
  const receipt = structuredClone(value) as unknown as Record<string, unknown>
  const observation = receipt.observation
  if (observation && typeof observation === 'object' && !Array.isArray(observation)) {
    const oldObservation = observation as Record<string, unknown>
    delete oldObservation.offerVersionRef
    delete oldObservation.checkedOfferVersionRef
    delete oldObservation.currentOfferVersionRef
  }
  return receipt
}
const legacyTurnDigest = (taskId: string, turnId: string, workspaceValue: Record<string, unknown>, text: string): string => bookingDigest({ schemaVersion: 'booking.surface', kind: 'user.turn', taskId, turnId, workspace: workspaceValue, request: { text } })
const turn = (taskId: string, revision = 0) => ({
  schemaVersion: 'booking.surface' as const, kind: 'user.turn' as const, taskId,
  turnId: `${taskId}-turn-${revision}`,
  workspace: workspace(revision), request: { text: 'find hotels in Dubai' },
})
const action = (id: string, revision = 0, extra: Record<string, unknown> = {}) => ({
  schemaVersion: 'booking.surface' as const, kind: 'search.run' as const, actionId: id,
  contextRef: 'ctx-v2', expectedRevision: revision, reason: 'search current workspace', factRefs: [], input: {}, ...extra,
})

const AUTHORIZATION_HEADER = 'authorization'
const dispatchFixtureAuth = ['fixture', 'dispatch', 'log', 'key'].join('-')
const DISPATCH_LOG_HOSTILE_MARKERS = [
  'ISSUE_329_USER_MARKER',
  'task-hostile-329',
  '/tmp/issue-329-secret-path',
  'sk_test_329_FAKE_ONLY',
  dispatchFixtureAuth,
]

async function runDispatchLogChild(): Promise<void> {
  const childRoot = mkdtempSync(join(tmpdir(), 'gotry-booking-v2-dispatch-log-child-'))
  class DispatchFixtureRuntime extends BookingCopilotTaskRuntime {
    resumeTask(taskId: string): BookingCopilotTaskState | null {
      if (taskId === 'task-329-known') throw new Error('workspace_mismatch')
      if (taskId === 'task-329-unknown') throw new Error(`unknown_dispatch_reason:${DISPATCH_LOG_HOSTILE_MARKERS.join(':')}`)
      if (taskId === 'task-329-suffixed') throw new Error(`workspace_mismatch:${DISPATCH_LOG_HOSTILE_MARKERS.join(':')}`)
      return super.resumeTask(taskId)
    }
  }
  const childLedger = ensureLedger(childRoot)
  const runtime = new DispatchFixtureRuntime(childLedger, { contextRefFactory: () => 'ctx-v2' })
  const server = await startBookingCopilotServer({
    apiKey: dispatchFixtureAuth,
    runtime,
    plannerFactory: () => ({ next: async () => [] }),
  })
  process.stdout.write(`READY ${server.port}\n`)
  const shutdown = async () => {
    await server.close()
    childLedger.close()
    rmSync(childRoot, { recursive: true, force: true })
    process.exit(0)
  }
  process.once('SIGTERM', () => { void shutdown() })
  await new Promise<void>(() => {})
}

if (process.argv[2] === '--dispatch-log-child') {
  await runDispatchLogChild()
  process.exit(0)
}

async function assertDispatchRejectionStderr(): Promise<void> {
  const script = fileURLToPath(import.meta.url)
  const tsx = fileURLToPath(new URL('../node_modules/tsx/dist/cli.mjs', import.meta.url))
  const child = spawn(process.execPath, [tsx, script, '--dispatch-log-child'], {
    cwd: process.cwd(), env: {
      GOTRY_SESSION_LIVE: '0',
      GOTRY_HBCLI_LIVE: '0',
      GOTRY_HOTELBYTE_SKILLS_LIVE: '0',
    }, stdio: ['ignore', 'pipe', 'pipe'],
  })
  const stdoutChunks: Buffer[] = []
  const stderrChunks: Buffer[] = []
  child.stdout.on('data', (chunk: Buffer) => { stdoutChunks.push(Buffer.from(chunk)) })
  child.stderr.on('data', (chunk: Buffer) => { stderrChunks.push(Buffer.from(chunk)) })
  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })))
  const cases = [
    ['task-329-known', 'WORKSPACE_MISMATCH', 'workspace_mismatch'],
    ['task-329-unknown', 'PLANNER_FAILED', 'UNCLASSIFIED'],
    ['task-329-suffixed', 'WORKSPACE_MISMATCH', 'UNCLASSIFIED'],
  ] as const
  try {
    const deadline = Date.now() + 10_000
    while (!Buffer.concat(stdoutChunks).toString('utf8').includes('READY ')) {
      if (Date.now() > deadline) throw new Error(`dispatch_log_child_not_ready:${Buffer.concat(stderrChunks).toString('utf8')}`)
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    const port = Number(Buffer.concat(stdoutChunks).toString('utf8').match(/READY (\d+)/)?.[1])
    assert.ok(Number.isInteger(port) && port > 0)
    const headers = { [AUTHORIZATION_HEADER]: ['Bearer', dispatchFixtureAuth].join(' '), 'content-type': 'application/json', 'x-booking-surface-version': BOOKING_SURFACE_SCHEMA_VERSION, 'x-booking-surface-schema-sha256': BOOKING_SURFACE_SCHEMA_SHA256 }
    for (const [taskId, expectedCode, expectedReason] of cases) {
      const response = await fetch(`http://127.0.0.1:${port}/a2a/booking-copilot/turn`, { method: 'POST', headers, body: JSON.stringify(turn(taskId)) })
      assert.equal(response.status, 409, `${taskId} keeps the dispatch conflict status`)
      const responseText = JSON.stringify(await response.json())
      assert.equal(responseText, JSON.stringify({ error: { code: expectedCode } }), `${taskId} keeps the typed safe response body`)
      for (const marker of DISPATCH_LOG_HOSTILE_MARKERS) {
        assert.equal(responseText.includes(marker), false, `${taskId} response omits ${marker}`)
      }
    }
  } finally {
    child.kill('SIGTERM')
    let timeout: NodeJS.Timeout | undefined
    const gracefullyExited = await Promise.race([
      exit,
      new Promise<null>((resolve) => { timeout = setTimeout(() => resolve(null), 1_000) }),
    ])
    if (timeout) clearTimeout(timeout)
    if (gracefullyExited === null) {
      child.kill('SIGKILL')
      await exit
    }
  }
  const childExit = await exit
  assert.deepEqual(childExit, { code: 0, signal: null }, 'dispatch log fixture shuts down cleanly')
  const stderrBytes = Buffer.concat(stderrChunks)
  const stderr = stderrBytes.toString('utf8')
  const entries = stderr.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as Record<string, string>)
  assert.equal(entries.length, cases.length, 'child stderr contains one structured entry per dispatch rejection')
  assert.ok(entries.every((entry) => Object.keys(entry).sort().join(',') === 'code,reason'), 'stderr entries contain only code and reason')
  assert.deepEqual(entries, cases.map(([, code, reason]) => ({ code, reason })), 'known and unclassified reasons are exact and ordered')
  for (const marker of DISPATCH_LOG_HOSTILE_MARKERS) {
    assert.equal(stderrBytes.includes(Buffer.from(marker)), false, `stderr bytes omit ${marker}`)
  }
  console.log(`BOOKING DISPATCH LOG PROOF: HTTP 409/child stderr bytes OK (stderr_sha256=${createHash('sha256').update(stderrBytes).digest('hex')})`)
}

await assertDispatchRejectionStderr()

// Repaired planner fact refs are evidence citations, never capability tokens.
// Even authority-looking values must not grant an action, a newer offer
// version, or the verified tuple required to prepare Checkout.
const repairedFactRef = `modelref:${'a'.repeat(64)}`
{
  const root = mkdtempSync(join(tmpdir(), 'gotry-booking-v2-factref-action-authority-'))
  const ledger = ensureLedger(root)
  const rt = new BookingCopilotTaskRuntime(ledger, { contextRefFactory: () => 'ctx-v2', now: () => '2026-09-01T10:00:00.000Z' })
  const limitedWorkspace: BookingWorkspaceSnapshot = {
    ...workspace(0),
    capabilities: { surface: 'tenant', allowedActions: ['search.run'] },
  }
  const t = rt.startTask({ ...turn('task-factref-action-authority'), workspace: limitedWorkspace })
  const before = ledger.countEvents()
  assert.throws(() => rt.issueOperation(t.taskId, {
    ...action('factref-forged-action', 0, { factRefs: [repairedFactRef, 'checkout.prepare'] }),
    kind: 'checkout.prepare' as const,
    input: { offerRef: 'offer-a', offerVersionRef: 'offer-a:v1', verifiedOfferRef: 'verified-offer-a' },
  }), /unsupported_action/, 'factRefs cannot add an action to the surface allowlist')
  assert.equal(ledger.countEvents(), before, 'rejected factRef authority does not persist an operation')
  ledger.close(); rmSync(root, { recursive: true, force: true })
}
{
  const root = mkdtempSync(join(tmpdir(), 'gotry-booking-v2-factref-offer-authority-'))
  const ledger = ensureLedger(root)
  const rt = new BookingCopilotTaskRuntime(ledger, { contextRefFactory: () => 'ctx-v2' })
  const offerWorkspace: BookingWorkspaceSnapshot = {
    ...workspace(0),
    visibleHotels: [{ hotelRef: 'hotel-a', name: 'Hotel A', factRefs: [] }],
    loadedOffers: [loadedOffer('offer-a', 'hotel-a', 'offer-a:v1')],
  }
  const t = rt.startTask({ ...turn('task-factref-offer-authority'), workspace: offerWorkspace })
  const before = ledger.countEvents()
  assert.throws(() => rt.issueOperation(t.taskId, {
    ...action('factref-forged-version', 0, { factRefs: [repairedFactRef, 'offer-a:v2'] }),
    kind: 'offer.check' as const,
    input: { offerRef: 'offer-a', offerVersionRef: 'offer-a:v2' },
  }), /offer_version_not_loaded/, 'factRefs cannot promote an unloaded offer version')
  assert.equal(ledger.countEvents(), before, 'rejected factRef version does not persist an operation')
  ledger.close(); rmSync(root, { recursive: true, force: true })
}
{
  const root = mkdtempSync(join(tmpdir(), 'gotry-booking-v2-factref-verified-authority-'))
  const ledger = ensureLedger(root)
  const rt = new BookingCopilotTaskRuntime(ledger, { contextRefFactory: () => 'ctx-v2', now: () => '2026-09-01T10:00:00.000Z' })
  const offerWorkspace: BookingWorkspaceSnapshot = {
    ...workspace(0),
    visibleHotels: [{ hotelRef: 'hotel-a', name: 'Hotel A', factRefs: [] }],
    loadedOffers: [loadedOffer('offer-a', 'hotel-a', 'offer-a:v1')],
    selectedOfferRef: 'offer-a',
  }
  const t = rt.startTask({ ...turn('task-factref-verified-authority'), workspace: offerWorkspace })
  const before = ledger.countEvents()
  assert.throws(() => rt.issueOperation(t.taskId, {
    ...action('factref-forged-verified', 0, { factRefs: [repairedFactRef, 'verified-offer-a'] }),
    kind: 'checkout.prepare' as const,
    input: { offerRef: 'offer-a', offerVersionRef: 'offer-a:v1', verifiedOfferRef: 'verified-offer-a' },
  }), /offer_version_not_loaded/, 'factRefs cannot create verified-offer authority')
  assert.equal(ledger.countEvents(), before, 'rejected factRef verification does not persist an operation')
  ledger.close(); rmSync(root, { recursive: true, force: true })
}

let id = 0
const runtime = new BookingCopilotTaskRuntime(ensureLedger(stateRoot), {
  idFactory: (prefix) => `${prefix}-${++id}`,
  now: () => '2026-09-01T10:00:00.000Z',
})
const task = runtime.startTask(turn('task-v2'))
assert.equal(task.taskId, 'task-v2')
assert.throws(() => runtime.startTask({ ...turn('task-no-id'), taskId: undefined } as never), /invalid_planner_turn/)
{
  const root = mkdtempSync(join(tmpdir(), 'gotry-booking-v2-same-revision-workspace-'))
  const ledger = ensureLedger(root)
  const rt = new BookingCopilotTaskRuntime(ledger, { contextRefFactory: () => 'ctx-v2', now: () => '2026-09-01T10:00:00.000Z' })
  const taskId = 'task-same-revision-workspace'
  const baseline: BookingWorkspaceSnapshot = {
    ...workspace(0),
    visibleHotels: [{ hotelRef: 'hotel-injected', name: 'Injected Hotel', factRefs: [] }],
    loadedOffers: [loadedOffer('offer-injected', 'hotel-injected'), loadedOffer('offer-peer', 'hotel-injected')],
    shortlistedOfferRefs: ['offer-injected', 'offer-peer'], selectedOfferRef: 'offer-injected',
  }
  const initial = rt.startTask({ ...turn(taskId), workspace: baseline })
  const workspaceInjectionCases: Array<{ name: string; workspace: BookingWorkspaceSnapshot }> = [
    {
      name: 'hotel-only',
      workspace: { ...baseline, visibleHotels: [{ ...baseline.visibleHotels[0], name: 'Injected Hotel Renamed' }] },
    },
    {
      name: 'loadedOffer-only',
      workspace: { ...baseline, loadedOffers: [baseline.loadedOffers[0], loadedOffer('offer-peer', 'hotel-injected', 'offer-peer:v2')] },
    },
    {
      name: 'selectedOfferRef-only',
      workspace: { ...baseline, selectedOfferRef: 'offer-peer' },
    },
    {
      name: 'shortlistedOfferRefs-only',
      workspace: { ...baseline, shortlistedOfferRefs: ['offer-injected'] },
    },
    {
      name: 'verifiedOffer-only',
      workspace: { ...baseline, verifiedOffer: verifiedCapability('offer-injected', 'offer-injected:v1', '2026-09-01T10:15:00.000Z') },
    },
  ]
  for (const [index, testCase] of workspaceInjectionCases.entries()) {
    const beforeRejectedTurn = ledger.countEvents()
    assert.throws(() => rt.startTask({ ...turn(taskId), turnId: `same-revision-injected-${index}`, workspace: testCase.workspace, request: { text: `book the ${testCase.name} offer` } }), /workspace_mismatch/, `${testCase.name} workspace injection is rejected as a digest mismatch`)
    assert.equal(ledger.countEvents(), beforeRejectedTurn, `${testCase.name} workspace mismatch leaves the ledger unchanged`)
  }
  const injectedCapabilityWorkspace = workspaceInjectionCases.at(-1)!.workspace
  const injectedCheckout = { offerRef: 'offer-injected', offerVersionRef: 'offer-injected:v1', verifiedOfferRef: 'verified-offer-injected' }
  const beforeRejectedCheckout = ledger.countEvents()
  assert.throws(() => rt.issueOperation(taskId, { ...action('same-revision-verified-injected-checkout'), kind: 'checkout.prepare' as const, input: injectedCheckout }), (error: unknown) => error instanceof Error && error.message === 'offer_version_not_loaded', 'CAS-rejected verified capability cannot authorize an exactly matching checkout.prepare')
  assert.equal(ledger.countEvents(), beforeRejectedCheckout, 'CAS-rejected verified checkout leaves the ledger unchanged')
  const controlRoot = mkdtempSync(join(tmpdir(), 'gotry-booking-v2-verified-authority-control-'))
  const controlLedger = ensureLedger(controlRoot)
  const controlRuntime = new BookingCopilotTaskRuntime(controlLedger, { contextRefFactory: () => 'ctx-v2', now: () => '2026-09-01T10:00:00.000Z' })
  const controlTask = controlRuntime.startTask({ ...turn('task-verified-authority-control'), workspace: injectedCapabilityWorkspace })
  const beforeControlCheckout = controlLedger.countEvents()
  const controlEvent = controlRuntime.issueOperation(controlTask.taskId, { ...action('verified-authority-control-checkout'), kind: 'checkout.prepare' as const, input: injectedCheckout })
  assert.equal(controlEvent.action.kind, 'checkout.prepare', 'matching verified capability authorizes checkout.prepare in the positive control')
  assert.equal(controlLedger.countEvents(), beforeControlCheckout + 1, 'positive-control checkout.prepare persists one ledger event')
  controlLedger.close(); rmSync(controlRoot, { recursive: true, force: true })
  const accepted = rt.startTask({ ...turn(taskId), turnId: 'same-revision-new-turn', workspace: baseline, request: { text: 'find hotels in Dubai again' } })
  assert.equal(accepted.userTurnCount, initial.userTurnCount + 1, 'same snapshot with a new turn identity and text remains accepted')
  const replayWorkspace0: BookingWorkspaceSnapshot = { ...workspace(0), visibleHotels: [{ hotelRef: 'replay-hotel', name: 'Replay Hotel', factRefs: [] }], loadedOffers: [loadedOffer('replay-offer', 'replay-hotel')] }
  const replayRoot = mkdtempSync(join(tmpdir(), 'gotry-booking-v2-pending-replay-order-'))
  const replayLedger = ensureLedger(replayRoot)
  const replayRuntime = new BookingCopilotTaskRuntime(replayLedger, { contextRefFactory: () => 'ctx-v2' })
  const replayTask = replayRuntime.startTask({ ...turn('task-pending-replay-order'), workspace: replayWorkspace0 })
  const replayAction = replayRuntime.issueOperation(replayTask.taskId, { ...action('pending-replay-check'), kind: 'offer.check' as const, input: { offerRef: 'replay-offer', offerVersionRef: 'replay-offer:v1' } })
  const beforeReplay = replayLedger.countEvents()
  const replayed = replayRuntime.startTask({ ...turn(replayTask.taskId), workspace: replayWorkspace0 })
  assert.equal(replayed.lastTurnId, replayTask.lastTurnId, 'same original user turn replays the existing pending task')
  assert.equal(replayLedger.countEvents(), beforeReplay, 'same original user turn replay leaves the ledger unchanged')
  assert.throws(() => replayRuntime.startTask({ ...turn(replayTask.taskId), turnId: 'pending-replay-new-turn', workspace: { ...replayWorkspace0, selectedOfferRef: 'replay-offer' }, request: { text: 'new turn while receipt is pending' } }), /receipt_required/, 'new turn keeps receipt_required priority over workspace mismatch')
  assert.equal(replayRuntime.resumeTask(replayTask.taskId)?.pendingAction?.actionId, replayAction.action.actionId)
  replayLedger.close(); rmSync(replayRoot, { recursive: true, force: true })
  const receiptTaskId = 'task-same-revision-receipt'
  const receiptWorkspace0: BookingWorkspaceSnapshot = { ...workspace(0), visibleHotels: [{ hotelRef: 'receipt-hotel', name: 'Receipt Hotel', factRefs: [] }], loadedOffers: [loadedOffer('receipt-offer', 'receipt-hotel')] }
  rt.startTask({ ...turn(receiptTaskId), workspace: receiptWorkspace0 })
  rt.startTask({ ...turn(receiptTaskId), turnId: 'receipt-same-snapshot-new-turn', workspace: receiptWorkspace0, request: { text: 'check this offer' } })
  rt.issueOperation(receiptTaskId, { ...action('same-revision-check'), kind: 'offer.check' as const, input: { offerRef: 'receipt-offer', offerVersionRef: 'receipt-offer:v1' } })
  const receiptWorkspace = { ...receiptWorkspace0, revision: 1 }
  const receipt: ActionReceipt = { schemaVersion: 'booking.surface', kind: 'action.receipt', actionId: 'same-revision-check', contextRef: 'ctx-v2', status: 'unavailable', revision: 1, observation: availabilityObservation('receipt-offer'), resultContract: { outcome: 'empty', hardCriteriaMet: false, factRefs: [], gapCodes: [], blockers: [], relaxationsApplied: [] } }
  const afterReceipt = rt.continueWithReceipt({ schemaVersion: 'booking.surface', kind: 'action.receipt.continuation', taskId: receiptTaskId, workspace: receiptWorkspace, receipt })
  assert.equal(afterReceipt.revision, 1, 'a normal receipt advances the durable revision')
  assert.doesNotThrow(() => rt.startTask({ ...turn(receiptTaskId, 1), turnId: 'post-receipt-new-turn', workspace: receiptWorkspace, request: { text: 'continue after the receipt' } }), 'same snapshot after a normal revision advance remains accepted')
  ledger.close(); rmSync(root, { recursive: true, force: true })
}
const directIngressRoot = mkdtempSync(join(tmpdir(), 'gotry-booking-v2-missing-task-'))
const directIngressLedger = ensureLedger(directIngressRoot)
const directIngressRuntime = new BookingCopilotTaskRuntime(directIngressLedger)
const directIngressBefore = directIngressLedger.countEvents()
try {
  assert.throws(() => directIngressRuntime.startTask({
    schemaVersion: 'booking.surface', kind: 'user.turn.ingress', requestKey: 'ingress-no-task', surfaceHint: 'tenant',
    workspace: { schemaVersion: 'booking.surface', revision: 0, locale: 'en-US', currency: 'AED', searchDraft: {}, results: { status: 'idle' }, visibleHotels: [], loadedOffers: [], shortlistedOfferRefs: [] },
    request: { text: 'find hotels in Dubai' },
  } as never), /ingress_binding_required/)
  assert.equal(directIngressLedger.countEvents(), directIngressBefore, 'browser ingress has no direct runtime ledger side effects')
} finally {
  try { directIngressLedger.close() } catch (closeError) {
    try { rmSync(directIngressRoot, { recursive: true, force: true }) } catch (rmError) {
      throw new AggregateError([closeError, rmError], 'directIngress fixture teardown failed')
    }
    throw closeError
  }
  rmSync(directIngressRoot, { recursive: true, force: true })
}
const selectedIngressRoot = mkdtempSync(join(tmpdir(), 'gotry-booking-v2-selected-ingress-'))
const selectedIngressLedger = ensureLedger(selectedIngressRoot)
const selectedIngressRuntime = new BookingCopilotTaskRuntime(selectedIngressLedger, { contextRefFactory: () => 'ctx-selected-ingress' })
const selectedIngress = {
  schemaVersion: 'booking.surface' as const, kind: 'user.turn.ingress' as const, requestKey: 'selected-ingress-request', taskHandle: 'opaque-task-handle', surfaceHint: 'tenant' as const,
  workspace: { schemaVersion: 'booking.surface' as const, revision: 0, locale: 'en-US', currency: 'AED', searchDraft: {}, results: { status: 'idle' as const }, visibleHotels: [{ hotelRef: 'hotel-selected', name: 'Selected Hotel', factRefs: [] }], loadedOffers: [loadedOffer('offer-selected', 'hotel-selected')], focusedHotelRef: 'hotel-selected', shortlistedOfferRefs: [], selectedOfferRef: 'offer-selected' },
  request: { text: 'is this selected room still bookable?' },
}
const selectedIngressTask = selectedIngressRuntime.startTask(turn('task-selected-ingress'))
const selectedPlannerTurn = selectedIngressRuntime.bindIngressTurn(selectedIngress, selectedIngressTask, 'turn-selected-ingress')
assert.equal(selectedPlannerTurn.workspace.focusedHotelRef, 'hotel-selected')
assert.equal(selectedPlannerTurn.workspace.selectedOfferRef, 'offer-selected')
assert.equal(selectedPlannerTurn.workspace.verifiedOffer, undefined, 'initial ingress cannot assert verified availability authority')
const selectedApproval: RelaxationApproval = {
  taskId: selectedIngressTask.taskId, contextRef: selectedIngressTask.contextRef,
  sourceTurnId: 'turn-source-ingress', presentationRequestKey: 'approval:task-selected-ingress:turn-source-ingress:action-source-ingress',
  optionDigest: 'a'.repeat(64), approvalId: 'approval-selected-ingress', deliveryNonce: 'nonce-selected-ingress',
  blockerId: 'blocker-selected-ingress', sourceActionId: 'action-source-ingress', sourceReceiptDigest: 'b'.repeat(64),
  scope: 'offer', code: 'criterion_must_not_met', criterionPath: 'offers.totalPriceMax', valueDigest: 'c'.repeat(64),
  from: 'must', to: 'prefer', approved: true,
}
const approvedSelectedIngress = { ...selectedIngress, request: { text: selectedIngress.request.text, approval: selectedApproval } }
const approvedSelectedPlannerTurn = selectedIngressRuntime.bindIngressTurn(approvedSelectedIngress, selectedIngressTask, 'turn-approved-selected-ingress')
assert.deepEqual(approvedSelectedPlannerTurn.request.approval, selectedApproval, 'runtime ingress binding preserves the exact canonical approval')
assert.notEqual(approvedSelectedPlannerTurn.request.approval, selectedApproval, 'runtime ingress binding clones approval data before planner admission')
assert.throws(() => selectedIngressRuntime.bindIngressTurn({ ...approvedSelectedIngress, request: { ...approvedSelectedIngress.request, approval: { ...selectedApproval, taskId: 'browser-forged-task' } } }, selectedIngressTask, 'turn-forged-selected-ingress'), /invalid_ingress_approval_authority/)
assert.throws(() => selectedIngressRuntime.bindIngressTurn({ ...approvedSelectedIngress, request: { ...approvedSelectedIngress.request, approval: { ...selectedApproval, contextRef: 'browser-forged-context' } } }, selectedIngressTask, 'turn-forged-context-selected-ingress'), /invalid_ingress_approval_authority/)
selectedIngressLedger.close(); rmSync(selectedIngressRoot, { recursive: true, force: true })
const duplicateOfferWorkspace: BookingWorkspaceSnapshot = { ...workspace(0), visibleHotels: [{ hotelRef: 'hotel-dup-a', name: 'Hotel Dup A', factRefs: [] }, { hotelRef: 'hotel-dup-b', name: 'Hotel Dup B', factRefs: [] }], loadedOffers: [loadedOffer('duplicate-offer-ref', 'hotel-dup-a'), loadedOffer('duplicate-offer-ref', 'hotel-dup-b')] }
const duplicateRoot = mkdtempSync(join(tmpdir(), 'gotry-booking-v2-duplicate-offer-'))
const duplicateLedger = ensureLedger(duplicateRoot)
const duplicateRuntime = new BookingCopilotTaskRuntime(duplicateLedger, { contextRefFactory: () => 'ctx-v2' })
assert.equal(validateBookingSurface({ ...turn('validator-duplicate-logical'), workspace: duplicateOfferWorkspace }).ok, false, 'published validator rejects duplicate logical offer refs')
const duplicateVersionWorkspace: BookingWorkspaceSnapshot = { ...workspace(0), visibleHotels: [{ hotelRef: 'hotel-dup-a', name: 'Hotel Dup A', factRefs: [] }, { hotelRef: 'hotel-dup-b', name: 'Hotel Dup B', factRefs: [] }], loadedOffers: [loadedOffer('offer-dup-a', 'hotel-dup-a', 'shared-offer:v1'), loadedOffer('offer-dup-b', 'hotel-dup-b', 'shared-offer:v1')] }
assert.equal(validateBookingSurface({ ...turn('validator-duplicate-version'), workspace: duplicateVersionWorkspace }).ok, false, 'published validator rejects duplicate offer version refs')
const verifiedVersionMismatchWorkspace: BookingWorkspaceSnapshot = { ...workspace(0), visibleHotels: [{ hotelRef: 'hotel-verified', name: 'Verified Hotel', factRefs: [] }], loadedOffers: [loadedOffer('offer-verified', 'hotel-verified', 'offer-verified:v1')], verifiedOffer: verifiedCapability('offer-verified', 'offer-verified:v2') }
assert.equal(validateBookingSurface({ ...turn('validator-verified-version-mismatch'), workspace: verifiedVersionMismatchWorkspace }).ok, false, 'standalone workspace validation rejects a verified capability for an unloaded version')
assert.equal(validateBookingSurface({ ...turn('validator-verified-logical-mismatch'), workspace: { ...verifiedVersionMismatchWorkspace, verifiedOffer: verifiedCapability('other-offer', 'other-offer:v1') } }).ok, false, 'standalone workspace validation rejects a verified capability for another logical offer')
assert.throws(() => duplicateRuntime.startTask({ ...turn('task-duplicate-offer'), workspace: duplicateOfferWorkspace }), /invalid_planner_turn|availability_duplicate_offer_ref/)
assert.equal(duplicateLedger.countEvents(), 0, 'duplicate loaded OfferRef is rejected at admission before ledger writes')
const duplicateContinuationRuntime = new BookingCopilotTaskRuntime(duplicateLedger, { contextRefFactory: () => 'ctx-v2' })
const duplicateContinuationTask = duplicateContinuationRuntime.startTask({ ...turn('task-duplicate-continuation'), workspace: { ...workspace(0), visibleHotels: [{ hotelRef: 'hotel-dup-a', name: 'Hotel Dup A', factRefs: [] }], loadedOffers: [loadedOffer('unique-offer-ref', 'hotel-dup-a')] } })
duplicateContinuationRuntime.issueOperation(duplicateContinuationTask.taskId, { ...action('duplicate-continuation-check'), kind: 'offer.check', input: { offerRef: 'unique-offer-ref', offerVersionRef: 'unique-offer-ref:v1' } })
assert.throws(() => duplicateContinuationRuntime.continueWithReceipt({ schemaVersion: 'booking.surface', kind: 'action.receipt.continuation', taskId: duplicateContinuationTask.taskId, workspace: { ...duplicateOfferWorkspace, revision: 1 }, receipt: { schemaVersion: 'booking.surface', kind: 'action.receipt', actionId: 'duplicate-continuation-check', contextRef: 'ctx-v2', status: 'unavailable', revision: 1, observation: availabilityObservation('unique-offer-ref'), resultContract: { outcome: 'empty', hardCriteriaMet: false, factRefs: [], gapCodes: [], blockers: [], relaxationsApplied: [] } } }), /invalid_receipt_continuation|availability_duplicate_offer_ref/)
;(duplicateContinuationRuntime as unknown as { appendTurn: (taskId: string, contextRef: string, requestDigest: string, workspaceDigest: string, workspaceSemanticDigest: string, ordinal: number, turnId: string, workspace: BookingWorkspaceSnapshot) => void }).appendTurn('task-duplicate-continuation', 'ctx-v2', 'tampered', 'tampered', 'tampered', 2, 'duplicate-replay-turn', duplicateOfferWorkspace)
assert.throws(() => duplicateContinuationRuntime.resumeTask('task-duplicate-continuation'), /ledger_corrupt:task-duplicate-continuation:turn_workspace/, 'duplicate loaded OfferRef is fail-closed during ledger replay')
duplicateLedger.close(); rmSync(duplicateRoot, { recursive: true, force: true })

// A receipt for offer A is not authority to mutate the selection to offer B.
// The receipt target and the resulting workspace selection must agree on the
// same logical/versioned offer pair.
const selectRoot = mkdtempSync(join(tmpdir(), 'gotry-booking-v2-select-receipt-binding-'))
const selectLedger = ensureLedger(selectRoot)
const selectRuntime = new BookingCopilotTaskRuntime(selectLedger, { contextRefFactory: () => 'ctx-v2' })
const selectWorkspace: BookingWorkspaceSnapshot = {
  ...workspace(0),
  visibleHotels: [{ hotelRef: 'hotel-a', name: 'Hotel A', factRefs: [] }, { hotelRef: 'hotel-b', name: 'Hotel B', factRefs: [] }],
  loadedOffers: [loadedOffer('offer-a', 'hotel-a'), loadedOffer('offer-b', 'hotel-b')],
  shortlistedOfferRefs: ['offer-a', 'offer-b'],
}
const selectTask = selectRuntime.startTask({ ...turn('task-select-receipt-binding'), workspace: selectWorkspace })
selectRuntime.issueOperation(selectTask.taskId, { ...action('select-a'), kind: 'offer.select' as const, input: { offerRef: 'offer-a', offerVersionRef: 'offer-a:v1' } })
assert.throws(() => selectRuntime.continueWithReceipt({
  schemaVersion: 'booking.surface', kind: 'action.receipt.continuation', taskId: selectTask.taskId,
  workspace: { ...selectWorkspace, revision: 1, selectedOfferRef: 'offer-b' },
  receipt: { schemaVersion: 'booking.surface', kind: 'action.receipt', actionId: 'select-a', contextRef: 'ctx-v2', status: 'applied', revision: 1, observation: { kind: 'offer.selection', offerRef: 'offer-a', offerVersionRef: 'offer-a:v1' }, resultContract: { outcome: 'complete', hardCriteriaMet: true, factRefs: [], gapCodes: [], blockers: [], relaxationsApplied: [] } },
}), /workspace_mismatch|receipt_transition/, 'offer.select receipt A cannot select offer B')
selectLedger.close(); rmSync(selectRoot, { recursive: true, force: true })

// Checkout is admitted only for the exact, unexpired verified capability tuple:
// logical offer, version and opaque verification ref all bind together.
const checkoutWorkspace = (revision: number, capability: VerifiedOfferCapability): BookingWorkspaceSnapshot => ({
  ...workspace(revision),
  visibleHotels: [{ hotelRef: 'hotel-a', name: 'Hotel A', factRefs: [] }, { hotelRef: 'hotel-b', name: 'Hotel B', factRefs: [] }],
  loadedOffers: [loadedOffer('offer-a', 'hotel-a'), loadedOffer('offer-b', 'hotel-b')],
  selectedOfferRef: 'offer-a',
  verifiedOffer: capability,
})
const checkoutReceipt = (actionId: string, offerRef: string, offerVersionRef: string, verifiedOfferRef: string): ActionReceipt => ({
  schemaVersion: 'booking.surface', kind: 'action.receipt', actionId, contextRef: 'ctx-v2', status: 'applied', revision: 1,
  observation: { kind: 'checkout.handoff', offerRef, offerVersionRef, verifiedOfferRef, handoffRef: `${offerRef}-checkout` },
  resultContract: { outcome: 'complete', hardCriteriaMet: true, factRefs: [], gapCodes: [], blockers: [], relaxationsApplied: [] },
})
{
  const root = mkdtempSync(join(tmpdir(), 'gotry-booking-v2-checkout-capability-'))
  const ledger = ensureLedger(root)
  const rt = new BookingCopilotTaskRuntime(ledger, { contextRefFactory: () => 'ctx-v2', now: () => '2026-09-01T10:00:00.000Z' })
  const capability = verifiedCapability('offer-a', 'offer-a:v1', '2026-09-01T10:30:00.000Z')
  const t = rt.startTask({ ...turn('task-checkout-capability-exact'), workspace: checkoutWorkspace(0, capability) })
  const checkout = { ...action('checkout-exact'), kind: 'checkout.prepare' as const, input: { offerRef: 'offer-a', offerVersionRef: 'offer-a:v1', verifiedOfferRef: capability.verifiedOfferRef } }
  rt.issueOperation(t.taskId, checkout)
  rt.continueWithReceipt({ schemaVersion: 'booking.surface', kind: 'action.receipt.continuation', taskId: t.taskId, workspace: checkoutWorkspace(1, capability), receipt: checkoutReceipt('checkout-exact', 'offer-a', 'offer-a:v1', capability.verifiedOfferRef) })
  assert.equal(rt.resumeTask(t.taskId)?.lastReceipt?.observation.kind, 'checkout.handoff', 'exact unexpired capability reaches checkout handoff')
  ledger.close(); rmSync(root, { recursive: true, force: true })
}
{
  const root = mkdtempSync(join(tmpdir(), 'gotry-booking-v2-checkout-after-check-'))
  const ledger = ensureLedger(root)
  const capability = verifiedCapability('offer-a', 'offer-a:v1', '2026-09-01T10:30:00.000Z')
  const before: BookingWorkspaceSnapshot = {
    ...workspace(0),
    visibleHotels: [{ hotelRef: 'hotel-a', name: 'Hotel A', factRefs: [] }],
    loadedOffers: [loadedOffer('offer-a', 'hotel-a')],
    shortlistedOfferRefs: ['offer-a'],
    selectedOfferRef: 'offer-a',
  }
  const after: BookingWorkspaceSnapshot = { ...before, revision: 1, verifiedOffer: capability }
  const writer = new BookingCopilotTaskRuntime(ledger, { contextRefFactory: () => 'ctx-v2', now: () => '2026-09-01T10:00:00.000Z' })
  const t = writer.startTask({ ...turn('task-checkout-after-check'), workspace: before })
  writer.issueOperation(t.taskId, { ...action('check-before-checkout'), kind: 'offer.check' as const, input: { offerRef: 'offer-a', offerVersionRef: 'offer-a:v1' } })
  writer.continueWithReceipt({
    schemaVersion: 'booking.surface', kind: 'action.receipt.continuation', taskId: t.taskId, workspace: after,
    receipt: { schemaVersion: 'booking.surface', kind: 'action.receipt', actionId: 'check-before-checkout', contextRef: 'ctx-v2', status: 'applied', revision: 1, observation: { kind: 'offer.availability', offerRef: 'offer-a', checkedOfferVersionRef: 'offer-a:v1', currentOfferVersionRef: 'offer-a:v1', verifiedOfferRef: capability.verifiedOfferRef, available: true, changedFactRefs: [], gapCodes: [] }, resultContract: { outcome: 'complete', hardCriteriaMet: true, factRefs: [], gapCodes: [], blockers: [], relaxationsApplied: [] } },
  })
  const confirmed = writer.resumeTask(t.taskId)
  assert.equal(confirmed?.availability.terminal?.code, 'availability_confirmed')
  assert.equal(confirmed?.phase, 'planning', 'confirmed availability keeps the same task plannable for checkout')
  assert.throws(() => writer.terminalDecisionBatch(t.taskId, 'receipt:check-before-checkout:after-check'), /task_not_terminal/, 'confirmed availability does not create a runtime-owned terminal batch')
  writer['ledger'].close()
  let checkoutNow = '2026-09-01T10:00:00.000Z'
  const reader = new BookingCopilotTaskRuntime(ensureLedger(root), { contextRefFactory: () => 'ctx-v2', now: () => checkoutNow })
  assert.equal(reader.resumeTask(t.taskId)?.phase, 'planning', 'confirmed availability remains plannable after ledger restart')
  const beforeCheckoutRows = reader['ledger'].countEvents()
  const swappedCapability = verifiedCapability('offer-b', 'offer-b:v1', '2026-09-01T10:30:00.000Z')
  const swappedWorkspace: BookingWorkspaceSnapshot = { ...after, visibleHotels: [{ hotelRef: 'hotel-b', name: 'Hotel B', factRefs: [] }], loadedOffers: [loadedOffer('offer-b', 'hotel-b')], shortlistedOfferRefs: ['offer-b'], selectedOfferRef: 'offer-b', verifiedOffer: swappedCapability }
  assert.throws(() => reader.startTask({ ...turn(t.taskId, 1), turnId: 'turn-swap-confirmed-offer', workspace: swappedWorkspace, request: { text: 'continue with the substituted offer' } }), /workspace_mismatch/, 'a same-revision turn cannot replace the offer tuple established by CheckAvail')
  assert.throws(() => reader.issueOperation(t.taskId, action('search-after-confirmed-direct', 1)), /availability_operation_incompatible/, 'direct operations cannot bypass the confirmed-state guard')
  assert.throws(() => reader.issueOperation(t.taskId, { ...action('query-after-confirmed-direct', 1), kind: 'offers.query' as const, input: { hotelRefs: ['hotel-a'], criteria: { targetCount: 1 } } }), /availability_operation_incompatible/, 'confirmed availability cannot query more offers')
  assert.throws(() => reader.issueOperation(t.taskId, { ...action('recheck-after-confirmed-direct', 1), kind: 'offer.check' as const, input: { offerRef: 'offer-a', offerVersionRef: 'offer-a:v1' } }), /availability_operation_incompatible/, 'confirmed availability cannot issue a second check')
  assert.throws(() => reader.issueOperation(t.taskId, { ...action('observe-after-confirmed-direct', 1), kind: 'order.observe' as const, input: { orderRef: 'order-a' } }), /availability_operation_incompatible/, 'confirmed availability cannot skip checkout and observe an order')
  assert.throws(() => reader.applyDecisionBatch(t.taskId, 'checkout-after-check-stale-batch', [{ kind: 'operation', action: { ...action('checkout-after-check-stale', 0), kind: 'checkout.prepare' as const, input: { offerRef: 'offer-a', offerVersionRef: 'offer-a:v1', verifiedOfferRef: capability.verifiedOfferRef } } }]), /stale_revision/, 'confirmed availability does not relax the semantic revision binding')
  assert.throws(() => reader.applyDecisionBatch(t.taskId, 'checkout-after-check-wrong-offer-batch', [{ kind: 'operation', action: { ...action('checkout-after-check-wrong-offer', 1), kind: 'checkout.prepare' as const, input: { offerRef: 'offer-b', offerVersionRef: 'offer-b:v1', verifiedOfferRef: capability.verifiedOfferRef } } }]), /availability_operation_incompatible/, 'confirmed availability does not relax the checked offer binding')
  assert.throws(() => reader.applyDecisionBatch(t.taskId, 'checkout-after-check-wrong-ref-batch', [{ kind: 'operation', action: { ...action('checkout-after-check-wrong-ref', 1), kind: 'checkout.prepare' as const, input: { offerRef: 'offer-a', offerVersionRef: 'offer-a:v1', verifiedOfferRef: 'verified-other' } } }]), /availability_operation_incompatible/, 'confirmed availability does not relax the verified ref binding')
  assert.throws(() => reader.applyDecisionBatch(t.taskId, 'checkout-after-check-wrong-version-batch', [{ kind: 'operation', action: { ...action('checkout-after-check-wrong-version', 1), kind: 'checkout.prepare' as const, input: { offerRef: 'offer-a', offerVersionRef: 'offer-a:v2', verifiedOfferRef: capability.verifiedOfferRef } } }]), /availability_operation_incompatible/, 'confirmed availability does not relax the checked version binding')
  assert.throws(() => reader.applyDecisionBatch(t.taskId, 'checkout-after-check-search-batch', [{ kind: 'operation', action: action('search-after-confirmed', 1) }]), /availability_operation_incompatible/, 'confirmed availability does not allow unrelated read actions')
  assert.throws(() => reader.applyDecisionBatch(t.taskId, 'checkout-after-check-explanation-only-batch', [{ kind: 'explanation', explanation: { text: 'extra', factRefs: [] } }]), /availability_operation_required/, 'confirmed availability cannot emit a non-final explanation instead of checkout or typed finality')
  assert.throws(() => reader.applyDecisionBatch(t.taskId, 'checkout-after-check-mixed-batch', [{ kind: 'operation', action: { ...action('checkout-after-check-mixed', 1), kind: 'checkout.prepare' as const, input: { offerRef: 'offer-a', offerVersionRef: 'offer-a:v1', verifiedOfferRef: capability.verifiedOfferRef } } }, { kind: 'explanation', explanation: { text: 'extra', factRefs: [] } }]), /availability_operation_required/, 'confirmed availability admits only a single checkout.prepare operation batch')
  checkoutNow = '2026-09-01T10:31:00.000Z'
  assert.throws(() => reader.applyDecisionBatch(t.taskId, 'checkout-after-check-expired-batch', [{ kind: 'operation', action: { ...action('checkout-after-check-expired', 1), kind: 'checkout.prepare' as const, input: { offerRef: 'offer-a', offerVersionRef: 'offer-a:v1', verifiedOfferRef: capability.verifiedOfferRef } } }]), /availability_operation_incompatible/, 'confirmed availability cannot use an expired verified capability')
  checkoutNow = '2026-09-01T10:00:00.000Z'
  assert.equal(reader['ledger'].countEvents(), beforeCheckoutRows, 'rejected confirmed-state turns and decisions do not append ledger rows')
  reader.applyDecisionBatch(t.taskId, 'checkout-after-check-batch', [{ kind: 'operation', action: { ...action('checkout-after-check', 1), kind: 'checkout.prepare' as const, input: { offerRef: 'offer-a', offerVersionRef: 'offer-a:v1', verifiedOfferRef: capability.verifiedOfferRef } } }])
  assert.equal(reader.resumeTask(t.taskId)?.pendingAction?.kind, 'checkout.prepare', 'checkout.prepare binds to the same checked offer/version/verified ref after confirmation')
  const checkoutHandoffReceipt = checkoutReceipt('checkout-after-check', 'offer-a', 'offer-a:v1', capability.verifiedOfferRef)
  const checkoutTerminalState = reader.continueWithReceipt({ schemaVersion: 'booking.surface', kind: 'action.receipt.continuation', taskId: t.taskId, workspace: { ...after, revision: 2 }, receipt: { ...checkoutHandoffReceipt, revision: 2 } })
  assert.equal(checkoutTerminalState.phase, 'terminal', 'applied checkout handoff closes the task')
  const checkoutTerminalKey = `receipt:checkout-after-check:${reader.receiptDigest({ ...checkoutHandoffReceipt, revision: 2 })}`
  const checkoutTerminalBatch = reader.terminalDecisionBatch(t.taskId, checkoutTerminalKey)
  assert.deepEqual(checkoutTerminalBatch.map((event) => event.kind), ['terminal'], 'checkout handoff has a once-only terminal replay batch')
  assert.equal(checkoutTerminalBatch[0]?.kind === 'terminal' ? checkoutTerminalBatch[0].terminal.summary : '', 'checkout_handoff_prepared')
  const checkoutTerminalRows = reader['ledger'].countEvents()
  reader.continueWithReceipt({ schemaVersion: 'booking.surface', kind: 'action.receipt.continuation', taskId: t.taskId, workspace: { ...after, revision: 2 }, receipt: { ...checkoutHandoffReceipt, revision: 2 } })
  assert.equal(reader['ledger'].countEvents(), checkoutTerminalRows, 'exact checkout receipt replay does not append a second terminal')
  assert.throws(() => reader.continueWithReceipt({ schemaVersion: 'booking.surface', kind: 'action.receipt.continuation', taskId: t.taskId, workspace: { ...after, revision: 2 }, receipt: { ...checkoutHandoffReceipt, status: 'partial', revision: 2, resultContract: { ...checkoutHandoffReceipt.resultContract, outcome: 'partial', hardCriteriaMet: false, gapCodes: ['surface_adapter_failed'] } } }), /receipt_conflict/, 'a conflicting checkout receipt cannot overwrite the terminal result')
  assert.throws(() => reader.issueOperation(t.taskId, { ...action('checkout-after-terminal', 2), kind: 'checkout.prepare' as const, input: { offerRef: 'offer-a', offerVersionRef: 'offer-a:v1', verifiedOfferRef: capability.verifiedOfferRef } }), /task_terminal/, 'checkout handoff permits no second operation')
  reader['ledger'].close()
  const terminalReader = new BookingCopilotTaskRuntime(ensureLedger(root), { now: () => checkoutNow })
  assert.equal(terminalReader.resumeTask(t.taskId)?.phase, 'terminal', 'checkout handoff terminal survives restart')
  assert.deepEqual(terminalReader.readDecisionBatch(t.taskId, checkoutTerminalKey), checkoutTerminalBatch, 'checkout handoff terminal batch survives restart byte-for-byte')
  terminalReader['ledger'].close(); rmSync(root, { recursive: true, force: true })
}
{
  const root = mkdtempSync(join(tmpdir(), 'gotry-booking-v2-checkout-not-prepared-'))
  const ledger = ensureLedger(root)
  const rt = new BookingCopilotTaskRuntime(ledger, { contextRefFactory: () => 'ctx-v2', now: () => '2026-09-01T10:00:00.000Z' })
  const capability = verifiedCapability('offer-a', 'offer-a:v1', '2026-09-01T10:30:00.000Z')
  const before: BookingWorkspaceSnapshot = { ...workspace(0), visibleHotels: [{ hotelRef: 'hotel-a', name: 'Hotel A', factRefs: [] }], loadedOffers: [loadedOffer('offer-a', 'hotel-a')], shortlistedOfferRefs: ['offer-a'], selectedOfferRef: 'offer-a' }
  const checked: BookingWorkspaceSnapshot = { ...before, revision: 1, verifiedOffer: capability }
  const beginCheckout = (taskId: string, checkActionId: string, checkoutActionId: string): void => {
    const task = rt.startTask({ ...turn(taskId), workspace: before })
    rt.issueOperation(task.taskId, { ...action(checkActionId), kind: 'offer.check' as const, input: { offerRef: 'offer-a', offerVersionRef: 'offer-a:v1' } })
    rt.continueWithReceipt({ schemaVersion: 'booking.surface', kind: 'action.receipt.continuation', taskId, workspace: checked, receipt: { schemaVersion: 'booking.surface', kind: 'action.receipt', actionId: checkActionId, contextRef: 'ctx-v2', status: 'applied', revision: 1, observation: { kind: 'offer.availability', offerRef: 'offer-a', checkedOfferVersionRef: 'offer-a:v1', currentOfferVersionRef: 'offer-a:v1', verifiedOfferRef: capability.verifiedOfferRef, available: true, changedFactRefs: [], gapCodes: [] }, resultContract: { outcome: 'complete', hardCriteriaMet: true, factRefs: [], gapCodes: [], blockers: [], relaxationsApplied: [] } } })
    rt.applyDecisionBatch(taskId, `batch-${checkoutActionId}`, [{ kind: 'operation', action: { ...action(checkoutActionId, 1), kind: 'checkout.prepare' as const, input: { offerRef: 'offer-a', offerVersionRef: 'offer-a:v1', verifiedOfferRef: capability.verifiedOfferRef } } }])
  }

  beginCheckout('task-checkout-incomplete', 'check-before-incomplete', 'checkout-incomplete')
  const incompleteReceipt: ActionReceipt = {
    ...checkoutReceipt('checkout-incomplete', 'offer-a', 'offer-a:v1', capability.verifiedOfferRef), revision: 2,
    resultContract: { outcome: 'partial', hardCriteriaMet: false, factRefs: [], gapCodes: ['surface_adapter_failed'], blockers: [], relaxationsApplied: [] },
  }
  rt.continueWithReceipt({ schemaVersion: 'booking.surface', kind: 'action.receipt.continuation', taskId: 'task-checkout-incomplete', workspace: { ...checked, revision: 2 }, receipt: incompleteReceipt })
  const incompleteKey = `receipt:checkout-incomplete:${rt.receiptDigest(incompleteReceipt)}`
  const incompleteTerminal = rt.readDecisionBatch('task-checkout-incomplete', incompleteKey)
  assert.equal(incompleteTerminal?.[0]?.kind === 'terminal' ? incompleteTerminal[0].terminal.status : '', 'stopped', 'an incomplete checkout handoff cannot claim success')
  assert.equal(incompleteTerminal?.[0]?.kind === 'terminal' ? incompleteTerminal[0].terminal.summary : '', 'checkout_handoff_not_prepared')

  beginCheckout('task-checkout-failed', 'check-before-failed', 'checkout-failed')
  const failedReceipt: ActionReceipt = {
    schemaVersion: 'booking.surface', kind: 'action.receipt', actionId: 'checkout-failed', contextRef: 'ctx-v2', status: 'failed', revision: 2,
    observation: { kind: 'gap', code: 'surface_adapter_failed', factRefs: [] },
    resultContract: { outcome: 'empty', hardCriteriaMet: false, factRefs: [], gapCodes: ['surface_adapter_failed'], blockers: [], relaxationsApplied: [] },
  }
  rt.continueWithReceipt({ schemaVersion: 'booking.surface', kind: 'action.receipt.continuation', taskId: 'task-checkout-failed', workspace: { ...checked, revision: 2 }, receipt: failedReceipt })
  const failedKey = `receipt:checkout-failed:${rt.receiptDigest(failedReceipt)}`
  const failedTerminal = rt.readDecisionBatch('task-checkout-failed', failedKey)
  assert.equal(failedTerminal?.[0]?.kind === 'terminal' ? failedTerminal[0].terminal.status : '', 'stopped', 'a failed checkout handoff terminates without planner retry')
  assert.equal(failedTerminal?.[0]?.kind === 'terminal' ? failedTerminal[0].terminal.summary : '', 'checkout_handoff_not_prepared')

  beginCheckout('task-checkout-atomic', 'check-before-atomic', 'checkout-atomic')
  const atomicReceipt = { ...checkoutReceipt('checkout-atomic', 'offer-a', 'offer-a:v1', capability.verifiedOfferRef), revision: 2 }
  const atomicTurn = { schemaVersion: 'booking.surface' as const, kind: 'action.receipt.continuation' as const, taskId: 'task-checkout-atomic', workspace: { ...checked, revision: 2 }, receipt: atomicReceipt }
  const beforeAtomicReceiptRows = ledger.countEvents()
  ledger.db.exec("CREATE TRIGGER abort_checkout_terminal_batch BEFORE INSERT ON events WHEN NEW.kind = 'booking.copilot.decision.batch' AND NEW.run_id = 'task-checkout-atomic' BEGIN SELECT RAISE(ABORT, 'crash_before_checkout_terminal_batch'); END")
  assert.throws(() => rt.continueWithReceipt(atomicTurn), /crash_before_checkout_terminal_batch|SQLITE_CONSTRAINT/, 'a crash before the checkout terminal batch aborts the whole receipt transaction')
  assert.equal(ledger.countEvents(), beforeAtomicReceiptRows, 'failed checkout terminal transaction leaves no receipt or terminal event tail')
  assert.equal(rt.resumeTask('task-checkout-atomic')?.pendingAction?.kind, 'checkout.prepare', 'checkout action remains pending after the simulated crash')
  ledger.db.exec('DROP TRIGGER abort_checkout_terminal_batch')
  const atomicTerminal = rt.continueWithReceipt(atomicTurn)
  assert.equal(atomicTerminal.phase, 'terminal', 'retry after the simulated crash reaches one terminal state')
  assert.equal((ledger.db.prepare("SELECT COUNT(*) AS n FROM events WHERE run_id = ? AND kind = 'booking.copilot.receipt.observed'").get('task-checkout-atomic') as { n: number }).n, 2, 'task retains one check receipt and one checkout receipt')
  assert.equal((ledger.db.prepare("SELECT COUNT(*) AS n FROM events WHERE run_id = ? AND kind = 'booking.copilot.event.emitted' AND json_extract(payload, '$.eventKind') = 'terminal'").get('task-checkout-atomic') as { n: number }).n, 1, 'retry records exactly one checkout terminal event')
  assert.equal((ledger.db.prepare("SELECT COUNT(*) AS n FROM events WHERE run_id = ? AND kind = 'booking.copilot.decision.batch' AND json_extract(payload, '$.requestKey') LIKE 'receipt:checkout-atomic:%'").get('task-checkout-atomic') as { n: number }).n, 1, 'retry records exactly one checkout terminal decision batch')
  ledger.close(); rmSync(root, { recursive: true, force: true })
}
{
  const root = mkdtempSync(join(tmpdir(), 'gotry-booking-v2-confirmed-check-only-'))
  const ledger = ensureLedger(root)
  const capability = verifiedCapability('offer-a', 'offer-a:v1', '2026-09-01T10:30:00.000Z')
  const before: BookingWorkspaceSnapshot = { ...workspace(0), visibleHotels: [{ hotelRef: 'hotel-a', name: 'Hotel A', factRefs: [] }], loadedOffers: [loadedOffer('offer-a', 'hotel-a')], shortlistedOfferRefs: ['offer-a'], selectedOfferRef: 'offer-a' }
  const after: BookingWorkspaceSnapshot = { ...before, revision: 1, verifiedOffer: capability }
  const rt = new BookingCopilotTaskRuntime(ledger, { contextRefFactory: () => 'ctx-v2', now: () => '2026-09-01T10:00:00.000Z' })
  const t = rt.startTask({ ...turn('task-confirmed-check-only'), workspace: before })
  rt.issueOperation(t.taskId, { ...action('check-only-before-terminal'), kind: 'offer.check' as const, input: { offerRef: 'offer-a', offerVersionRef: 'offer-a:v1' } })
  rt.continueWithReceipt({ schemaVersion: 'booking.surface', kind: 'action.receipt.continuation', taskId: t.taskId, workspace: after, receipt: { schemaVersion: 'booking.surface', kind: 'action.receipt', actionId: 'check-only-before-terminal', contextRef: 'ctx-v2', status: 'applied', revision: 1, observation: { kind: 'offer.availability', offerRef: 'offer-a', checkedOfferVersionRef: 'offer-a:v1', currentOfferVersionRef: 'offer-a:v1', verifiedOfferRef: capability.verifiedOfferRef, available: true, changedFactRefs: [], gapCodes: [] }, resultContract: { outcome: 'complete', hardCriteriaMet: true, factRefs: [], gapCodes: [], blockers: [], relaxationsApplied: [] } } })
  const events = rt.applyDecisionBatch(t.taskId, 'check-only-completed-terminal', [{ kind: 'explanation', explanation: { text: 'The selected offer is still available.', factRefs: [] } }, { kind: 'terminal', terminal: { status: 'completed', summary: 'availability_confirmed', factRefs: [] } }])
  assert.deepEqual(events.map((event) => event.kind), ['status', 'explanation', 'terminal'], 'confirmed availability may close a check-only intent with explanation and completed terminal')
  assert.equal(rt.resumeTask(t.taskId)?.phase, 'terminal')
  const stoppedTask = rt.startTask({ ...turn('task-confirmed-check-only-stopped'), workspace: before })
  rt.issueOperation(stoppedTask.taskId, { ...action('check-only-before-stopped', 0), kind: 'offer.check' as const, input: { offerRef: 'offer-a', offerVersionRef: 'offer-a:v1' } })
  rt.continueWithReceipt({ schemaVersion: 'booking.surface', kind: 'action.receipt.continuation', taskId: stoppedTask.taskId, workspace: after, receipt: { schemaVersion: 'booking.surface', kind: 'action.receipt', actionId: 'check-only-before-stopped', contextRef: 'ctx-v2', status: 'applied', revision: 1, observation: { kind: 'offer.availability', offerRef: 'offer-a', checkedOfferVersionRef: 'offer-a:v1', currentOfferVersionRef: 'offer-a:v1', verifiedOfferRef: capability.verifiedOfferRef, available: true, changedFactRefs: [], gapCodes: [] }, resultContract: { outcome: 'complete', hardCriteriaMet: true, factRefs: [], gapCodes: [], blockers: [], relaxationsApplied: [] } } })
  assert.deepEqual(rt.applyDecisionBatch(stoppedTask.taskId, 'check-only-stopped-terminal', [{ kind: 'terminal', terminal: { status: 'stopped', summary: 'user_stopped_after_check', factRefs: [] } }]).map((event) => event.kind), ['status', 'terminal'], 'confirmed availability may close a check-only intent with a typed stopped terminal')
  const errorTask = rt.startTask({ ...turn('task-confirmed-check-only-error'), workspace: before })
  rt.issueOperation(errorTask.taskId, { ...action('check-only-before-error', 0), kind: 'offer.check' as const, input: { offerRef: 'offer-a', offerVersionRef: 'offer-a:v1' } })
  rt.continueWithReceipt({ schemaVersion: 'booking.surface', kind: 'action.receipt.continuation', taskId: errorTask.taskId, workspace: after, receipt: { schemaVersion: 'booking.surface', kind: 'action.receipt', actionId: 'check-only-before-error', contextRef: 'ctx-v2', status: 'applied', revision: 1, observation: { kind: 'offer.availability', offerRef: 'offer-a', checkedOfferVersionRef: 'offer-a:v1', currentOfferVersionRef: 'offer-a:v1', verifiedOfferRef: capability.verifiedOfferRef, available: true, changedFactRefs: [], gapCodes: [] }, resultContract: { outcome: 'complete', hardCriteriaMet: true, factRefs: [], gapCodes: [], blockers: [], relaxationsApplied: [] } } })
  assert.deepEqual(rt.applyDecisionBatch(errorTask.taskId, 'check-only-error-final', [{ kind: 'error', error: { code: 'PLANNER_FAILED', message: 'Planner stopped after check.', retryable: false } }]).map((event) => event.kind), ['status', 'error'], 'confirmed availability may close with a typed error finality')
  const historicalRows = ledger.countEvents()
  ledger.close()
  const historicalReader = new BookingCopilotTaskRuntime(ensureLedger(root))
  assert.equal(historicalReader.resumeTask(t.taskId)?.phase, 'terminal', 'a historical explicit terminal after confirmation remains terminal after restart')
  assert.equal(historicalReader['ledger'].countEvents(), historicalRows)
  historicalReader['ledger'].close(); rmSync(root, { recursive: true, force: true })
}
{
  const root = mkdtempSync(join(tmpdir(), 'gotry-booking-v2-confirmed-at-operation-limit-'))
  const ledger = ensureLedger(root)
  const rt = new BookingCopilotTaskRuntime(ledger, { contextRefFactory: () => 'ctx-v2', now: () => '2026-09-01T10:00:00.000Z' })
  const capability = verifiedCapability('offer-limit', 'offer-limit:v1', '2026-09-01T10:30:00.000Z')
  const before: BookingWorkspaceSnapshot = { ...workspace(0), visibleHotels: [{ hotelRef: 'hotel-limit', name: 'Limit Hotel', factRefs: [] }], loadedOffers: [loadedOffer('offer-limit', 'hotel-limit')], shortlistedOfferRefs: ['offer-limit'], selectedOfferRef: 'offer-limit' }
  const taskId = 'task-confirmed-at-operation-limit'
  rt.startTask({ ...turn(taskId), workspace: before })
  for (let ordinal = 1; ordinal < BOOKING_COPILOT_MAX_OPERATIONS; ordinal++) {
    const operation = rt.issueOperation(taskId, action(`limit-search-${ordinal}`))
    rt.continueWithReceipt({ schemaVersion: 'booking.surface', kind: 'action.receipt.continuation', taskId, workspace: before, receipt: { schemaVersion: 'booking.surface', kind: 'action.receipt', actionId: operation.action.actionId, contextRef: 'ctx-v2', status: 'applied', revision: 0, observation: { kind: 'search.state', resultCount: 1 }, resultContract: { outcome: 'complete', hardCriteriaMet: true, factRefs: [], gapCodes: [], blockers: [], relaxationsApplied: [] } } })
  }
  const check = rt.issueOperation(taskId, { ...action('limit-check'), kind: 'offer.check' as const, input: { offerRef: 'offer-limit', offerVersionRef: 'offer-limit:v1' } })
  assert.equal(rt.resumeTask(taskId)?.operationCount, BOOKING_COPILOT_MAX_OPERATIONS, 'the successful check is the actual twentieth operation')
  const checkReceipt: ActionReceipt = { schemaVersion: 'booking.surface', kind: 'action.receipt', actionId: check.action.actionId, contextRef: 'ctx-v2', status: 'applied', revision: 1, observation: { kind: 'offer.availability', offerRef: 'offer-limit', checkedOfferVersionRef: 'offer-limit:v1', currentOfferVersionRef: 'offer-limit:v1', verifiedOfferRef: capability.verifiedOfferRef, available: true, changedFactRefs: [], gapCodes: [] }, resultContract: { outcome: 'complete', hardCriteriaMet: true, factRefs: [], gapCodes: [], blockers: [], relaxationsApplied: [] } }
  const terminal = rt.continueWithReceipt({ schemaVersion: 'booking.surface', kind: 'action.receipt.continuation', taskId, workspace: { ...before, revision: 1, verifiedOffer: capability }, receipt: checkReceipt })
  assert.equal(terminal.availability.terminal?.code, 'availability_confirmed', 'the availability subflow records its conclusive success')
  assert.equal(terminal.phase, 'terminal')
  const limitBatch = rt.readDecisionBatch(taskId, `receipt:${checkReceipt.actionId}:${rt.receiptDigest(checkReceipt)}`)
  assert.equal(limitBatch?.[0]?.kind === 'terminal' ? limitBatch[0].terminal.status : '', 'stopped', 'the hard operation limit wins over a confirmed availability subflow')
  assert.equal(limitBatch?.[0]?.kind === 'terminal' ? limitBatch[0].terminal.summary : '', 'operation_limit_reached')
  assert.equal(limitBatch?.some((event) => event.kind === 'terminal' && event.terminal.summary === 'availability_confirmed'), false, 'operation limit cannot be misreported as task success')
  ledger.close(); rmSync(root, { recursive: true, force: true })
}
{
  const root = mkdtempSync(join(tmpdir(), 'gotry-booking-v2-checkout-capability-cross-offer-'))
  const ledger = ensureLedger(root)
  const rt = new BookingCopilotTaskRuntime(ledger, { contextRefFactory: () => 'ctx-v2', now: () => '2026-09-01T10:00:00.000Z' })
  const capability = verifiedCapability('offer-a', 'offer-a:v1', '2026-09-01T10:30:00.000Z')
  const t = rt.startTask({ ...turn('task-checkout-capability-cross-offer'), workspace: checkoutWorkspace(0, capability) })
  assert.throws(() => rt.issueOperation(t.taskId, { ...action('checkout-cross-offer'), kind: 'checkout.prepare' as const, input: { offerRef: 'offer-b', offerVersionRef: 'offer-b:v1', verifiedOfferRef: capability.verifiedOfferRef } }), /verified_offer|offer_capability|offer_version/, 'offer A capability cannot authorize offer B')
  ledger.close(); rmSync(root, { recursive: true, force: true })
}
{
  const root = mkdtempSync(join(tmpdir(), 'gotry-booking-v2-checkout-capability-expired-'))
  const ledger = ensureLedger(root)
  const rt = new BookingCopilotTaskRuntime(ledger, { contextRefFactory: () => 'ctx-v2', now: () => '2026-09-01T10:00:00.000Z' })
  const expired = verifiedCapability('offer-a', 'offer-a:v1', '2026-09-01T09:59:59.000Z')
  const t = rt.startTask({ ...turn('task-checkout-capability-expired'), workspace: checkoutWorkspace(0, expired) })
  assert.throws(() => rt.issueOperation(t.taskId, { ...action('checkout-expired'), kind: 'checkout.prepare' as const, input: { offerRef: 'offer-a', offerVersionRef: 'offer-a:v1', verifiedOfferRef: expired.verifiedOfferRef } }), /verified_offer_expired|offer_capability_expired|capability_expired|offer_version_not_loaded/, 'expired verified capability is rejected')
  ledger.close(); rmSync(root, { recursive: true, force: true })
}
{
  const root = mkdtempSync(join(tmpdir(), 'gotry-booking-v2-expired-receipt-write-'))
  const ledger = ensureLedger(root)
  const rt = new BookingCopilotTaskRuntime(ledger, { contextRefFactory: () => 'ctx-v2', now: () => '2026-09-01T11:00:00.000Z' })
  const expired = verifiedCapability('offer-a', 'offer-a:v1', '2026-09-01T10:30:00.000Z')
  const before = checkoutWorkspace(0, expired)
  const after = checkoutWorkspace(1, expired)
  const t = rt.startTask({ ...turn('task-expired-receipt-write'), workspace: before })
  rt.issueOperation(t.taskId, { ...action('expired-receipt-check'), kind: 'offer.check' as const, input: { offerRef: 'offer-a', offerVersionRef: 'offer-a:v1' } })
  const receipt: ActionReceipt = { schemaVersion: 'booking.surface', kind: 'action.receipt', actionId: 'expired-receipt-check', contextRef: 'ctx-v2', status: 'applied', revision: 1, observation: { kind: 'offer.availability', offerRef: 'offer-a', checkedOfferVersionRef: 'offer-a:v1', currentOfferVersionRef: 'offer-a:v1', verifiedOfferRef: expired.verifiedOfferRef, available: true, changedFactRefs: [], gapCodes: [] }, resultContract: { outcome: 'complete', hardCriteriaMet: true, factRefs: [], gapCodes: [], blockers: [], relaxationsApplied: [] } }
  assert.throws(() => rt.continueWithReceipt({ schemaVersion: 'booking.surface', kind: 'action.receipt.continuation', taskId: t.taskId, workspace: after, receipt }), /receipt_verified_offer_expired/, 'expired capability is rejected at receipt write time')
  ledger.close(); rmSync(root, { recursive: true, force: true })
}
{
  const root = mkdtempSync(join(tmpdir(), 'gotry-booking-v2-expired-receipt-replay-'))
  const ledger = ensureLedger(root)
  const capability = verifiedCapability('offer-a', 'offer-a:v1', '2026-09-01T10:30:00.000Z')
  const before = checkoutWorkspace(0, capability)
  const after = checkoutWorkspace(1, capability)
  const writer = new BookingCopilotTaskRuntime(ledger, { contextRefFactory: () => 'ctx-v2', now: () => '2026-09-01T10:00:00.000Z' })
  const t = writer.startTask({ ...turn('task-expired-receipt-replay'), workspace: before })
  writer.issueOperation(t.taskId, { ...action('historical-check'), kind: 'offer.check' as const, input: { offerRef: 'offer-a', offerVersionRef: 'offer-a:v1' } })
  const historicalReceipt: ActionReceipt = { schemaVersion: 'booking.surface', kind: 'action.receipt', actionId: 'historical-check', contextRef: 'ctx-v2', status: 'applied', revision: 1, observation: { kind: 'offer.availability', offerRef: 'offer-a', checkedOfferVersionRef: 'offer-a:v1', currentOfferVersionRef: 'offer-a:v1', verifiedOfferRef: capability.verifiedOfferRef, available: true, changedFactRefs: [], gapCodes: [] }, resultContract: { outcome: 'complete', hardCriteriaMet: true, factRefs: [], gapCodes: [], blockers: [], relaxationsApplied: [] } }
  writer.continueWithReceipt({ schemaVersion: 'booking.surface', kind: 'action.receipt.continuation', taskId: t.taskId, workspace: after, receipt: historicalReceipt })
  const reader = new BookingCopilotTaskRuntime(ensureLedger(root), { contextRefFactory: () => 'ctx-v2', now: () => '2026-09-01T11:00:00.000Z' })
  const replayed = reader.resumeTask(t.taskId)
  assert.equal(replayed?.lastReceipt?.status, 'applied', 'historical accepted availability receipt remains replayable after capability expiry')
  assert.equal(replayed?.lastReceipt?.observation.kind === 'offer.availability' ? replayed.lastReceipt.observation.verifiedOfferRef : undefined, capability.verifiedOfferRef)
  reader['ledger'].close(); ledger.close(); rmSync(root, { recursive: true, force: true })
}
{
  const root = mkdtempSync(join(tmpdir(), 'gotry-booking-v2-partial-verified-offer-'))
  const ledger = ensureLedger(root)
  const capability = verifiedCapability('offer-a', 'offer-a:v1', '2026-09-01T10:30:00.000Z')
  const before = checkoutWorkspace(0, capability)
  const after = checkoutWorkspace(1, capability)
  const rt = new BookingCopilotTaskRuntime(ledger, { contextRefFactory: () => 'ctx-v2', now: () => '2026-09-01T10:00:00.000Z' })
  const t = rt.startTask({ ...turn('task-partial-verified-offer'), workspace: before })
  rt.issueOperation(t.taskId, { ...action('partial-verified-check'), kind: 'offer.check' as const, input: { offerRef: 'offer-a', offerVersionRef: 'offer-a:v1' } })
  const partialReceipt: ActionReceipt = { schemaVersion: 'booking.surface', kind: 'action.receipt', actionId: 'partial-verified-check', contextRef: 'ctx-v2', status: 'applied', revision: 1, observation: { kind: 'offer.availability', offerRef: 'offer-a', checkedOfferVersionRef: 'offer-a:v1', currentOfferVersionRef: 'offer-a:v1', verifiedOfferRef: capability.verifiedOfferRef, available: true, changedFactRefs: [], gapCodes: ['check_avail_unverified'] }, resultContract: { outcome: 'partial', hardCriteriaMet: false, factRefs: [], gapCodes: ['check_avail_unverified'], blockers: [], relaxationsApplied: [] } }
  assert.throws(() => rt.continueWithReceipt({ schemaVersion: 'booking.surface', kind: 'action.receipt.continuation', taskId: t.taskId, workspace: after, receipt: partialReceipt }), /workspace_mismatch|receipt_verified|availability_receipt|invalid_receipt/, 'partial applied availability cannot publish a checkout-authorizing verified capability')
  assert.throws(() => rt.issueOperation(t.taskId, { ...action('partial-verified-checkout'), kind: 'checkout.prepare' as const, input: { offerRef: 'offer-a', offerVersionRef: 'offer-a:v1', verifiedOfferRef: capability.verifiedOfferRef } }), /receipt_required|verified_offer|offer_version/, 'partial availability cannot authorize a later checkout')
  ledger.close(); rmSync(root, { recursive: true, force: true })
}
const operation = runtime.issueOperation(task.taskId, action('action-v2'))
assert.equal(operation.action.actionId, 'action-v2')
assert.equal(operation.action.kind, 'search.run')
assert.equal(runtime.resumeTask(task.taskId)?.pendingAction?.actionId, 'action-v2')
assert.throws(() => runtime.issueOperation(task.taskId, action('wrong-context', 0, { contextRef: 'ctx-other' })), /receipt_required/)
assert.throws(() => runtime.continueWithReceipt({
  schemaVersion: 'booking.surface', kind: 'action.receipt.continuation', taskId: task.taskId,
  workspace: workspace(1), receipt: {
    schemaVersion: 'booking.surface', kind: 'action.receipt', actionId: 'wrong', contextRef: 'ctx-v2',
    status: 'applied', revision: 1, observation: { kind: 'search.state', resultCount: 1 },
    resultContract: { outcome: 'complete', hardCriteriaMet: true, factRefs: [], gapCodes: [], blockers: [], relaxationsApplied: [] },
  },
}), /receipt_action_mismatch/)

const receipt = {
  schemaVersion: 'booking.surface' as const, kind: 'action.receipt' as const, actionId: 'action-v2', contextRef: 'ctx-v2',
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
const afterReceipt = runtime.continueWithReceipt({ schemaVersion: 'booking.surface', kind: 'action.receipt.continuation', taskId: task.taskId, workspace: workspace(1), receipt: receiptWithDigest })
assert.equal(afterReceipt.awaitingApproval?.blocker.blockerId, 'blocker-v2')
const offerRoot = mkdtempSync(join(tmpdir(), 'gotry-booking-v2-offer-target-'))
const offerRuntime = new BookingCopilotTaskRuntime(ensureLedger(offerRoot), { contextRefFactory: () => 'ctx-v2' })
const offerTurn = turn('task-offer-target')
const offerTask = offerRuntime.startTask({ ...offerTurn, workspace: { ...offerTurn.workspace, visibleHotels: [{ hotelRef: 'hotel-a', name: 'Hotel A', factRefs: [] }], loadedOffers: [loadedOffer('offer-a', 'hotel-a')] } })
offerRuntime.issueOperation(offerTask.taskId, { ...action('offer-action'), kind: 'offer.check', input: { offerRef: 'offer-a', offerVersionRef: 'offer-a:v1' } })
const offerReceipt = offerRuntime.withReceiptDigest({ ...receipt, actionId: 'offer-action', observation: availabilityObservation('offer-b', 'offer-b:v1', true), resultContract: { ...receipt.resultContract, blockers: [], gapCodes: [] } })
const offerWorkspace1 = { ...offerTurn.workspace, revision: 1, visibleHotels: [{ hotelRef: 'hotel-a', name: 'Hotel A', factRefs: [] }], loadedOffers: [loadedOffer('offer-a', 'hotel-a')] }
assert.throws(() => offerRuntime.continueWithReceipt({ schemaVersion: 'booking.surface', kind: 'action.receipt.continuation', taskId: offerTask.taskId, workspace: offerWorkspace1, receipt: offerReceipt }), /receipt_target_mismatch/)
const offerCheckWorkspace = (revision: number, selectedOfferRef?: string, shortlistedOfferRefs: string[] = ['offer-cleanup', 'offer-peer'], verifiedOffer?: VerifiedOfferCapability): BookingWorkspaceSnapshot => ({ ...workspace(revision), visibleHotels: [{ hotelRef: 'hotel-cleanup', name: 'Hotel Cleanup', factRefs: [] }], loadedOffers: [loadedOffer('offer-cleanup', 'hotel-cleanup'), loadedOffer('offer-peer', 'hotel-cleanup')], selectedOfferRef, shortlistedOfferRefs, ...(verifiedOffer ? { verifiedOffer } : {}) })
const checkReceipt = (actionId: string, status: 'applied' | 'unavailable' | 'changed' | 'no_match' | 'failed' | 'stale' | 'unsupported', available = status === 'changed'): ActionReceipt => ({ schemaVersion: 'booking.surface' as const, kind: 'action.receipt' as const, actionId, contextRef: 'ctx-v2', status, revision: 1, observation: { kind: 'offer.availability' as const, offerRef: 'offer-cleanup', checkedOfferVersionRef: 'offer-cleanup:v1', currentOfferVersionRef: available ? (status === 'changed' ? 'offer-cleanup:v2' : 'offer-cleanup:v1') : undefined, available, verifiedOfferRef: available && status !== 'changed' ? 'verified-offer-cleanup' : undefined, changedFactRefs: status === 'changed' ? ['price'] : [], gapCodes: [] }, resultContract: { outcome: status === 'changed' ? 'partial' as const : available ? 'complete' as const : status === 'unavailable' || status === 'no_match' ? 'empty' as const : 'partial' as const, hardCriteriaMet: available && status !== 'changed', factRefs: [], gapCodes: [], blockers: [], relaxationsApplied: [] } })
const assertOfferCheckContinuation = (name: string, before: BookingWorkspaceSnapshot, after: BookingWorkspaceSnapshot, receipt: ActionReceipt, pattern?: RegExp): void => {
  const root = mkdtempSync(join(tmpdir(), `gotry-booking-v2-${name}-`))
  const rt = new BookingCopilotTaskRuntime(ensureLedger(root), { contextRefFactory: () => 'ctx-v2', now: () => '2026-09-01T10:00:00.000Z' })
  const t = rt.startTask({ ...turn(`task-${name}`), workspace: before })
  rt.issueOperation(t.taskId, { ...action(`${name}-action`), kind: 'offer.check' as const, input: { offerRef: 'offer-cleanup', offerVersionRef: 'offer-cleanup:v1' } })
  if (pattern) assert.throws(() => rt.continueWithReceipt({ schemaVersion: 'booking.surface', kind: 'action.receipt.continuation', taskId: t.taskId, workspace: after, receipt: { ...receipt, actionId: `${name}-action` } }), pattern)
  else rt.continueWithReceipt({ schemaVersion: 'booking.surface', kind: 'action.receipt.continuation', taskId: t.taskId, workspace: after, receipt: { ...receipt, actionId: `${name}-action` } })
  rt['ledger'].close(); rmSync(root, { recursive: true, force: true })
}
assertOfferCheckContinuation('offer-success-first-check', offerCheckWorkspace(0, undefined), offerCheckWorkspace(1, 'offer-cleanup', ['offer-cleanup', 'offer-peer'], verifiedCapability('offer-cleanup')), checkReceipt('offer-success-first-check-action', 'applied', true))
assertOfferCheckContinuation('offer-success-peer-to-checked', offerCheckWorkspace(0, 'offer-peer'), offerCheckWorkspace(1, 'offer-cleanup', ['offer-cleanup', 'offer-peer'], verifiedCapability('offer-cleanup')), checkReceipt('offer-success-peer-to-checked-action', 'applied', true))
assertOfferCheckContinuation('offer-success-cleared-forbidden', offerCheckWorkspace(0, 'offer-peer'), offerCheckWorkspace(1, undefined, ['offer-peer'], verifiedCapability('offer-cleanup')), checkReceipt('offer-success-cleared-forbidden-action', 'applied', true), /workspace_mismatch/)
const cleanupRoot = mkdtempSync(join(tmpdir(), 'gotry-booking-v2-offer-cleanup-'))
const cleanupRuntime = new BookingCopilotTaskRuntime(ensureLedger(cleanupRoot), { contextRefFactory: () => 'ctx-v2' })
const cleanupWorkspace0: BookingWorkspaceSnapshot = { ...workspace(0), visibleHotels: [{ hotelRef: 'hotel-cleanup', name: 'Hotel Cleanup', factRefs: [] }], loadedOffers: [loadedOffer('offer-cleanup', 'hotel-cleanup'), loadedOffer('offer-peer', 'hotel-cleanup')], selectedOfferRef: 'offer-cleanup', shortlistedOfferRefs: ['offer-cleanup', 'offer-peer'], verifiedOffer: verifiedCapability('offer-cleanup', 'offer-cleanup:v1', '2026-09-01T10:30:00.000Z') }
const cleanupTask = cleanupRuntime.startTask({ ...turn('task-offer-cleanup'), workspace: cleanupWorkspace0 })
const cleanupAction = { ...action('offer-cleanup-action'), kind: 'offer.check' as const, input: { offerRef: 'offer-cleanup', offerVersionRef: 'offer-cleanup:v1' } }
cleanupRuntime.issueOperation(cleanupTask.taskId, cleanupAction)
const cleanupReceipt = { schemaVersion: 'booking.surface' as const, kind: 'action.receipt' as const, actionId: 'offer-cleanup-action', contextRef: 'ctx-v2', status: 'unavailable' as const, revision: 1, observation: { kind: 'offer.availability' as const, offerRef: 'offer-cleanup', checkedOfferVersionRef: 'offer-cleanup:v1', available: false, changedFactRefs: [], gapCodes: [] }, resultContract: { outcome: 'empty' as const, hardCriteriaMet: false, factRefs: [], gapCodes: [], blockers: [], relaxationsApplied: [] } }
const cleanupWorkspace1: BookingWorkspaceSnapshot = { ...cleanupWorkspace0, revision: 1, selectedOfferRef: undefined, shortlistedOfferRefs: ['offer-peer'], verifiedOffer: undefined }
cleanupRuntime.continueWithReceipt({ schemaVersion: 'booking.surface', kind: 'action.receipt.continuation', taskId: cleanupTask.taskId, workspace: cleanupWorkspace1, receipt: cleanupReceipt })
assert.equal(cleanupRuntime.resumeTask(cleanupTask.taskId)?.lastReceipt?.status, 'unavailable', 'offer.check can clear only the checked selection/shortlist and stale verification while preserving loaded offer evidence')
const unavailableRows = cleanupRuntime['ledger'].countEvents()
assert.throws(() => cleanupRuntime.issueOperation(cleanupTask.taskId, action('search-during-offer-refresh', 1)), /availability_operation_incompatible/, 'direct runtime cannot bypass the required offers.query recovery step')
assert.throws(() => cleanupRuntime.issueOperation(cleanupTask.taskId, { ...action('observe-during-offer-refresh', 1), kind: 'order.observe' as const, input: { orderRef: 'order-not-yet-created' } }), /availability_operation_incompatible/, 'unavailable recovery cannot skip to order observation')
assert.equal(cleanupRuntime['ledger'].countEvents(), unavailableRows, 'rejected unavailable-recovery actions append no rows')
assertOfferCheckContinuation('offer-negative-kept-checked-forbidden', cleanupWorkspace0, { ...cleanupWorkspace1, selectedOfferRef: 'offer-cleanup', shortlistedOfferRefs: ['offer-cleanup', 'offer-peer'] }, cleanupReceipt, /workspace_mismatch/)
const cleanupChangedWorkspace1: BookingWorkspaceSnapshot = { ...cleanupWorkspace0, revision: 1, loadedOffers: [{ ...loadedOffer('offer-cleanup', 'hotel-cleanup', 'offer-cleanup:v2'), factRefs: ['price'] }, loadedOffer('offer-peer', 'hotel-cleanup')], verifiedOffer: undefined }
const changedRuntimeRoot = mkdtempSync(join(tmpdir(), 'gotry-booking-v2-offer-changed-runtime-'))
const changedRuntime = new BookingCopilotTaskRuntime(ensureLedger(changedRuntimeRoot), { contextRefFactory: () => 'ctx-v2' })
const changedTask = changedRuntime.startTask({ ...turn('task-offer-changed-runtime'), workspace: cleanupWorkspace0 })
changedRuntime.issueOperation(changedTask.taskId, { ...action('offer-changed-seed-query'), kind: 'offers.query' as const, input: { hotelRefs: ['hotel-cleanup'], criteria: {} } })
const changedSeedWorkspace: BookingWorkspaceSnapshot = { ...cleanupWorkspace0, revision: 1 }
changedRuntime.continueWithReceipt({ schemaVersion: 'booking.surface', kind: 'action.receipt.continuation', taskId: changedTask.taskId, workspace: changedSeedWorkspace, receipt: { schemaVersion: 'booking.surface', kind: 'action.receipt', actionId: 'offer-changed-seed-query', contextRef: 'ctx-v2', status: 'applied', revision: 1, observation: { kind: 'offers.state', hotelRefs: ['hotel-cleanup'], offerRefs: ['offer-cleanup', 'offer-peer'], loadedHotelCount: 1 }, resultContract: { outcome: 'complete', hardCriteriaMet: true, factRefs: [], gapCodes: [], blockers: [], relaxationsApplied: [] } } })
changedRuntime.issueOperation(changedTask.taskId, { ...action('offer-changed-runtime-check', 1), kind: 'offer.check' as const, input: { offerRef: 'offer-cleanup', offerVersionRef: 'offer-cleanup:v1' } })
changedRuntime.continueWithReceipt({ schemaVersion: 'booking.surface', kind: 'action.receipt.continuation', taskId: changedTask.taskId, workspace: { ...cleanupChangedWorkspace1, revision: 2 }, receipt: { ...checkReceipt('offer-changed-runtime-check', 'changed'), revision: 2 } })
assert.equal(changedRuntime.resumeTask(changedTask.taskId)?.lastReceipt?.status, 'changed', 'runtime persists changed availability against a replacement offer version')
changedRuntime['ledger'].close(); rmSync(changedRuntimeRoot, { recursive: true, force: true })
// Existing search results may be checked directly before GoTry has issued an
// offers.query. This is the product-critical v1 -> v2 recovery path: the
// changed receipt must survive restart, then the replacement version must be
// the only admissible next CheckAvail candidate.
const directChangedRoot = mkdtempSync(join(tmpdir(), 'gotry-booking-v2-direct-offer-changed-'))
const directChangedRuntime = new BookingCopilotTaskRuntime(ensureLedger(directChangedRoot), { contextRefFactory: () => 'ctx-v2' })
const directChangedTask = directChangedRuntime.startTask({ ...turn('task-direct-offer-changed'), workspace: cleanupWorkspace0 })
directChangedRuntime.issueOperation(directChangedTask.taskId, { ...action('direct-offer-check-v1'), kind: 'offer.check' as const, input: { offerRef: 'offer-cleanup', offerVersionRef: 'offer-cleanup:v1' } })
const directChangedWorkspace: BookingWorkspaceSnapshot = { ...cleanupChangedWorkspace1, revision: 1 }
directChangedRuntime.continueWithReceipt({ schemaVersion: 'booking.surface', kind: 'action.receipt.continuation', taskId: directChangedTask.taskId, workspace: directChangedWorkspace, receipt: checkReceipt('direct-offer-check-v1', 'changed') })
assert.equal(directChangedRuntime.resumeTask(directChangedTask.taskId)?.lastReceipt?.status, 'changed', 'direct first CheckAvail changed receipt is durable')
const directChangedRestart = new BookingCopilotTaskRuntime(ensureLedger(directChangedRoot), { contextRefFactory: () => 'ctx-v2' })
const resumedDirect = directChangedRestart.resumeTask(directChangedTask.taskId)
assert.equal(resumedDirect?.lastReceipt?.observation.kind, 'offer.availability')
assert.equal(resumedDirect?.lastReceipt?.observation.kind === 'offer.availability' ? resumedDirect.lastReceipt.observation.currentOfferVersionRef : undefined, 'offer-cleanup:v2', 'restart retains replacement offer version')
const changedRows = directChangedRestart['ledger'].countEvents()
assert.throws(() => directChangedRestart.issueOperation(directChangedTask.taskId, action('search-during-recheck', 1)), /availability_operation_incompatible/, 'direct runtime cannot bypass the required replacement-version recheck')
assert.equal(directChangedRestart['ledger'].countEvents(), changedRows, 'rejected changed-recovery action appends no rows')
const recheckV2 = { ...action('direct-offer-check-v2', 1), kind: 'offer.check' as const, input: { offerRef: 'offer-cleanup', offerVersionRef: 'offer-cleanup:v2' } }
directChangedRestart.issueOperation(directChangedTask.taskId, recheckV2)
directChangedRuntime['ledger'].close(); directChangedRestart['ledger'].close(); rmSync(directChangedRoot, { recursive: true, force: true })
assertOfferCheckContinuation('offer-no-match-cleanup', cleanupWorkspace0, cleanupWorkspace1, { ...cleanupReceipt, status: 'no_match' })
assertOfferCheckContinuation('offer-failed-drift-forbidden', cleanupWorkspace0, cleanupWorkspace1, { ...cleanupReceipt, status: 'failed', resultContract: { ...cleanupReceipt.resultContract, outcome: 'partial' } }, /workspace_mismatch/)
assertOfferCheckContinuation('offer-stale-drift-forbidden', cleanupWorkspace0, cleanupWorkspace1, { ...cleanupReceipt, status: 'stale', resultContract: { ...cleanupReceipt.resultContract, outcome: 'partial' } }, /workspace_mismatch/)
assertOfferCheckContinuation('offer-unsupported-drift-forbidden', cleanupWorkspace0, cleanupWorkspace1, { ...cleanupReceipt, status: 'unsupported', resultContract: { ...cleanupReceipt.resultContract, outcome: 'partial' } }, /workspace_mismatch/)
const replacedRoot = mkdtempSync(join(tmpdir(), 'gotry-booking-v2-offer-cleanup-replaced-'))
const replacedRuntime = new BookingCopilotTaskRuntime(ensureLedger(replacedRoot), { contextRefFactory: () => 'ctx-v2' })
const replacedTask = replacedRuntime.startTask({ ...turn('task-offer-cleanup-replaced'), workspace: cleanupWorkspace0 })
replacedRuntime.issueOperation(replacedTask.taskId, { ...cleanupAction, actionId: 'offer-cleanup-replaced' })
assert.throws(() => replacedRuntime.continueWithReceipt({ schemaVersion: 'booking.surface', kind: 'action.receipt.continuation', taskId: replacedTask.taskId, workspace: { ...cleanupWorkspace1, selectedOfferRef: 'offer-peer' }, receipt: { ...cleanupReceipt, actionId: 'offer-cleanup-replaced' } }), /workspace_mismatch/, 'offer.check cannot replace selection with a different offer')
const loadedDriftRoot = mkdtempSync(join(tmpdir(), 'gotry-booking-v2-offer-cleanup-loaded-drift-'))
const loadedDriftRuntime = new BookingCopilotTaskRuntime(ensureLedger(loadedDriftRoot), { contextRefFactory: () => 'ctx-v2' })
const loadedDriftTask = loadedDriftRuntime.startTask({ ...turn('task-offer-cleanup-loaded-drift'), workspace: cleanupWorkspace0 })
loadedDriftRuntime.issueOperation(loadedDriftTask.taskId, { ...cleanupAction, actionId: 'offer-cleanup-loaded-drift' })
assert.throws(() => loadedDriftRuntime.continueWithReceipt({ schemaVersion: 'booking.surface', kind: 'action.receipt.continuation', taskId: loadedDriftTask.taskId, workspace: { ...cleanupWorkspace1, loadedOffers: [loadedOffer('offer-peer', 'hotel-cleanup')] }, receipt: { ...cleanupReceipt, actionId: 'offer-cleanup-loaded-drift' } }), /workspace_mismatch/, 'offer.check cannot mutate loadedOffers evidence')
cleanupRuntime['ledger'].close(); replacedRuntime['ledger'].close(); loadedDriftRuntime['ledger'].close()
rmSync(cleanupRoot, { recursive: true, force: true }); rmSync(replacedRoot, { recursive: true, force: true }); rmSync(loadedDriftRoot, { recursive: true, force: true })
const approvalQuestion = runtime.approvalQuestion(task.taskId)
assert.equal(approvalQuestion.kind, 'question')
if (approvalQuestion.kind === 'question') {
  assert.equal(approvalQuestion.question.blocker.blockerId, 'blocker-v2')
  assert.equal(approvalQuestion.question.approvalOptions[0]?.approval.sourceActionId, 'action-v2')
}
const awaitingRestart = new BookingCopilotTaskRuntime(ensureLedger(stateRoot), { now: () => '2026-09-01T10:00:00.000Z' })
assert.equal(awaitingRestart.resumeTask(task.taskId)?.awaitingApproval?.blocker.blockerId, 'blocker-v2')
const approval = approvalQuestion.kind === 'question' ? approvalQuestion.question.approvalOptions[0]!.approval : (() => { throw new Error('missing approval option') })()
assert.throws(() => runtime.startTask({ ...turn(task.taskId, 1), request: { text: 'relax destination', approval } }), /approval_not_presented/)
// A persisted outbox intent alone is not a presentation.  If the process
// dies before the durable question batch, even a recovered option is refused.
const awaitingBeforeBatch = runtime.resumeTask(task.taskId)?.awaitingApproval
assert.ok(awaitingBeforeBatch)
const approvalPresentationKey = runtime.approvalPresentationRequestKey(task.taskId)
;(runtime as unknown as { ensureApprovalOffered: (taskId: string, contextRef: string, approval: BookingApprovalState, requestKey: string) => void }).ensureApprovalOffered(task.taskId, task.contextRef, awaitingBeforeBatch!, approvalPresentationKey)
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
const expiredRuntime = new BookingCopilotTaskRuntime(ensureLedger(stateRoot), { now: () => '2026-09-01T10:03:00.000Z' })
assert.throws(() => expiredRuntime.issueOperation(task.taskId, action('action-v2-expired', 1)), /approval_expired/)
const approvedOperation = runtime.issueOperation(task.taskId, action('action-v2-relaxed', 1))
assert.equal(approvedOperation.action.relaxationApprovalRef?.targetActionId, 'action-v2-relaxed')
assert.equal(approvedOperation.action.relaxationApprovalRef?.targetActionKind, 'search.run')
assert.throws(() => runtime.issueOperation(task.taskId, action('action-v2-relaxed-again', 1)), /receipt_required/)
// A replay with a fresh request key/turn id must fail closed after the
// runtime has consumed the canonical approval, before planner admission.
assert.throws(() => runtime.assertApprovalNotConsumed(task.taskId, approval), /approval_replayed/)

const reopened = new BookingCopilotTaskRuntime(ensureLedger(stateRoot), { now: () => '2026-09-01T10:00:00.000Z' })
assert.equal(reopened.resumeTask(task.taskId)?.lastReceipt?.actionId, 'action-v2')
assert.equal(reopened.resumeTask(task.taskId)?.pendingAction?.actionId, 'action-v2-relaxed')
assert.throws(() => reopened.issueOperation(task.taskId, { ...action('forged-ref', 1), relaxationApprovalRef: { ...approvedOperation.action.relaxationApprovalRef!, targetActionId: 'forged-ref' } }), /receipt_required/)
const forgedTask = runtime.startTask(turn('task-forged', 1))
assert.throws(() => runtime.issueOperation(forgedTask.taskId, action('forged-ref', 1, { relaxationApprovalRef: { ...approvedOperation.action.relaxationApprovalRef!, targetActionId: 'forged-ref' } })), /approval_ref_planner_owned_forbidden/)
const forgedSourceRoot = mkdtempSync(join(tmpdir(), 'gotry-booking-v2-forged-source-'))
const forgedSourceRuntime = new BookingCopilotTaskRuntime(ensureLedger(forgedSourceRoot), { contextRefFactory: () => 'ctx-v2' })
const forgedSourceTask = forgedSourceRuntime.startTask(turn('task-forged-source'))
forgedSourceRuntime.issueOperation(forgedSourceTask.taskId, action('action-real'))
const forgedSourceReceipt = forgedSourceRuntime.withReceiptDigest({ ...receipt, actionId: 'action-real', resultContract: { ...receipt.resultContract, blockers: [{ ...receipt.resultContract.blockers[0]!, sourceActionId: 'action-forged' }] } })
assert.throws(() => forgedSourceRuntime.continueWithReceipt({ schemaVersion: 'booking.surface', kind: 'action.receipt.continuation', taskId: forgedSourceTask.taskId, workspace: workspace(1), receipt: forgedSourceReceipt }), /receipt_source_action_mismatch/)
assert.equal(forgedSourceRuntime.resumeTask(forgedSourceTask.taskId)?.pendingAction?.actionId, 'action-real', 'forged blocker is rejected before receipt append')
const tamperRoot = mkdtempSync(join(tmpdir(), 'gotry-booking-v2-tamper-'))
const tamperLedger = ensureLedger(tamperRoot)
const tamperRuntime = new BookingCopilotTaskRuntime(tamperLedger)
tamperRuntime.startTask(turn('task-tamper'))
tamperLedger.insertEvent({ actor: 'tamper', kind: 'booking.copilot.user.turn.observed', subjectId: 'task-tamper', runId: 'task-tamper', idemKey: 'tamper-turn', payload: { schema: 'booking.copilot.ledger', taskId: 'task-tamper', contextRef: 'ctx-v2', requestDigest: 'tampered', approval: { forged: true } } })
assert.throws(() => tamperRuntime.resumeTask('task-tamper'), /ledger_corrupt:task-tamper:turn_approval/)

const serverRoot = mkdtempSync(join(tmpdir(), 'gotry-booking-v2-server-'))
let serverId = 0
const serverRuntime = new BookingCopilotTaskRuntime(ensureLedger(serverRoot), { idFactory: (prefix) => `${prefix}-server-${++serverId}`, contextRefFactory: () => 'ctx-server' })
let factoryCalls = 0
let plannerCalls = 0
let resolveApprovalPlannerEntered!: () => void
const approvalPlannerEntered = new Promise<void>((resolve) => { resolveApprovalPlannerEntered = resolve })
let releaseApprovalPlanner!: () => void
const approvalPlannerRelease = new Promise<void>((resolve) => { releaseApprovalPlanner = resolve })
let approvalPlannerDeferred = false
const server = await startBookingCopilotServer({
  apiKey: 'v2-server-key',
  runtime: serverRuntime,
  principal: { subject: 'bff-principal-a', scope: 'booking:read' },
  ingressBinding: { bind: (input) => ({ taskId: 'task-server', turnId: `turn-${input.requestKey}`, contextRef: 'ctx-server', surface: 'tenant', allowedActions: [...BOOKING_FULL_JOURNEY_ACTION_KINDS] }) },
  ingressMode: 'bff-ingress-binding',
  plannerFactory: (initial: BookingCopilotTaskState) => { factoryCalls++; return { next: async ({ turn, task: current }) => { plannerCalls++; if (turn.kind === 'user.turn' && turn.request.approval && !approvalPlannerDeferred) { approvalPlannerDeferred = true; resolveApprovalPlannerEntered(); await approvalPlannerRelease } const decision: BookingPlannerDecision = { kind: 'operation', action: { ...action(`server-action-${plannerCalls}`, current.revision), contextRef: current.contextRef } }; return [decision] } } },
})
const endpoint = `http://127.0.0.1:${server.port}/a2a/booking-copilot/turn`
const headers = { authorization: 'Bearer v2-server-key', 'content-type': 'application/json', 'x-booking-surface-version': BOOKING_SURFACE_SCHEMA_VERSION, 'x-booking-surface-schema-sha256': BOOKING_SURFACE_SCHEMA_SHA256 }
const ingress = { schemaVersion: 'booking.surface', kind: 'user.turn.ingress', requestKey: 'ingress-request-1', taskHandle: 'opaque-task-handle-1', surfaceHint: 'tenant', workspace: { schemaVersion: 'booking.surface', revision: 0, locale: 'en-US', currency: 'AED', searchDraft: {}, results: { status: 'idle' }, visibleHotels: [], loadedOffers: [], shortlistedOfferRefs: [] }, request: { text: 'find hotels in Dubai' } }
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
  schemaVersion: 'booking.surface' as const, kind: 'action.receipt.continuation' as const, taskId: 'task-server', workspace: postActionWorkspace,
  receipt: { schemaVersion: 'booking.surface' as const, kind: 'action.receipt' as const, actionId: pending.actionId, contextRef: 'ctx-server', status: 'applied' as const, revision: 1,
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
const deliveredQuestion = JSON.parse(deliveredQuestionMatch[1]!) as { question: { approvalOptions: Array<{ approval: RelaxationApproval }> } }
const approved = questionApproval.kind === 'question' ? questionApproval.question.approvalOptions[0]!.approval : undefined
assert.ok(approved)
assert.equal(deliveredQuestion.question.approvalOptions[0]!.approval.deliveryNonce, approved.deliveryNonce, 'SSE carries the durable unpredictable presentation nonce')
const serverEventCountBeforeApprovalIngress = serverRuntime['ledger'].countEvents()
const forgedApprovalIngress = { ...ingress, requestKey: 'forged-approval-ingress-request-1', workspace: { ...ingress.workspace, revision: 2 }, request: { text: 'prefer a nearby match', approval: { ...approved, taskId: 'browser-forged-task', contextRef: 'browser-forged-context' } } }
const forgedApprovalResponse = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(forgedApprovalIngress) })
assert.equal(forgedApprovalResponse.status, 400, 'mismatched browser approval authority is rejected before planner/runtime side effects')
assert.match(await forgedApprovalResponse.text(), /invalid_ingress_approval_authority/)
assert.equal(plannerCalls, 2, 'forged approval ingress does not call the planner')
assert.equal(serverRuntime['ledger'].countEvents(), serverEventCountBeforeApprovalIngress, 'forged approval ingress does not append ledger events')
const approvedIngress = { ...ingress, requestKey: 'approval-ingress-request-1', workspace: { ...ingress.workspace, revision: 2 }, request: { text: 'prefer a nearby match', approval: { ...approved } } }
const approvedResponsePromise = fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(approvedIngress) })
await approvalPlannerEntered
const concurrentApprovalPromises = ['approval-concurrent-a', 'approval-concurrent-b'].map((requestKey) => fetch(endpoint, { method: 'POST', headers, body: JSON.stringify({ ...approvedIngress, requestKey }) }))
let concurrentApprovalResponses: Response[] | undefined
let concurrentApprovalFailure: unknown
let rejectConcurrentTimeout!: (reason?: unknown) => void
const concurrentTimeout = setTimeout(() => rejectConcurrentTimeout(new Error('concurrent approval replay joined the in-flight planner')), 2_000)
try {
  concurrentApprovalResponses = await Promise.race([
    Promise.all(concurrentApprovalPromises),
    new Promise<never>((_resolve, reject) => { rejectConcurrentTimeout = reject }),
  ])
} catch (cause) {
  concurrentApprovalFailure = cause
} finally {
  clearTimeout(concurrentTimeout)
  releaseApprovalPlanner()
}
const approvedResponse = await approvedResponsePromise
if (concurrentApprovalFailure) throw concurrentApprovalFailure
assert.ok(concurrentApprovalResponses)
assert.ok(concurrentApprovalResponses.every(({ status }) => status === 409), 'concurrent exact approvals with fresh keys fail closed before planner replay')
for (const response of concurrentApprovalResponses) assert.match(await response.text(), /PLANNER_FAILED/, 'approval replay is fail-closed at the HTTP boundary')
assert.equal(approvedResponse.status, 200)
const approvedBody = await approvedResponse.text()
assert.equal(plannerCalls, 3)
assert.match(approvedBody, /event: operation/)
assert.equal(plannerCalls, 3, 'concurrent approval retries never enter planner')
assert.equal((serverRuntime['ledger'].db.prepare("SELECT COUNT(*) AS n FROM events WHERE kind = 'booking.copilot.approval.consumed' AND run_id = ?").get('task-server') as { n: number }).n, 1, 'approval is consumed exactly once')
const approvedPayloadRows = serverRuntime['ledger'].db.prepare("SELECT payload FROM events WHERE kind = 'booking.copilot.user.turn.observed' AND run_id = ? ORDER BY seq DESC").all('task-server') as Array<{ payload: string }>
const approvedPayload = JSON.parse(approvedPayloadRows[0]!.payload)
assert.equal(approvedPayload.contextRef, 'ctx-server')
const consumedApprovalRows = serverRuntime['ledger'].db.prepare("SELECT payload FROM events WHERE kind = 'booking.copilot.approval.granted' AND run_id = ? ORDER BY seq DESC").all('task-server') as Array<{ payload: string }>
const consumedApprovalPayload = JSON.parse(consumedApprovalRows[0]!.payload)
assert.deepEqual(consumedApprovalPayload.approval.approval, approved, 'exact ingress approval is forwarded unchanged into runtime approval consumption')
const crashRoot = mkdtempSync(join(tmpdir(), 'gotry-booking-v2-crash-replay-'))
const crashLedger = ensureLedger(crashRoot)
const crashV2 = new BookingCopilotTaskRuntime(crashLedger)
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
const atomicRuntime = new BookingCopilotTaskRuntime(atomicLedger)
const atomicTurn = turn('task-atomic-binding')
const atomicBinding = { requestKey: 'atomic-request-1', principal: { subject: 'bff-atomic', scope: 'booking:read' }, taskHandle: 'atomic-task-handle' }
atomicLedger.db.exec("CREATE TRIGGER abort_booking_request_binding BEFORE INSERT ON events WHEN NEW.kind = 'booking.copilot.request.binding' BEGIN SELECT RAISE(ABORT, 'crash_after_start_before_binding'); END")
assert.throws(() => atomicRuntime.startTask(atomicTurn, atomicBinding), /crash_after_start_before_binding|SQLITE_CONSTRAINT/)
assert.equal(atomicLedger.countEvents(), 0, 'binding failure rolls back STARTED and TURN reservation')
atomicLedger.db.exec('DROP TRIGGER abort_booking_request_binding')
atomicRuntime.startTask(atomicTurn, atomicBinding)
const atomicCount = atomicLedger.countEvents()
atomicRuntime.startTask(atomicTurn, atomicBinding)
assert.equal(atomicLedger.countEvents(), atomicCount, 'same request binding retry does not create a second task/planner turn')
assert.equal((atomicLedger.db.prepare("SELECT COUNT(*) AS n FROM events WHERE kind = 'booking.copilot.request.binding'").get() as { n: number }).n, 1)
assert.throws(() => atomicRuntime.startTask(atomicTurn, { ...atomicBinding, principal: { subject: 'other-principal', scope: 'booking:read' } }), /principal_conflict|request_conflict/, 'taskHandle cannot be rebound across principals')
assert.throws(() => atomicRuntime.startTask(turn('task-atomic-binding-other'), { ...atomicBinding, requestKey: 'atomic-request-2' }), /task_handle_conflict/, 'taskHandle cannot bind a second task in the same principal scope')
atomicLedger.close(); rmSync(atomicRoot, { recursive: true, force: true })
const crossRoot = mkdtempSync(join(tmpdir(), 'gotry-booking-cross-task-context-'))
const crossLedger = ensureLedger(crossRoot)
const crossRuntime = new BookingCopilotTaskRuntime(crossLedger)
crossRuntime.startTask({ ...turn('task-cross-context'), workspace: { ...workspace(), contextRef: 'ctx-cross' } })
assert.throws(() => crossRuntime.startTask({ ...turn('task-cross-context'), workspace: { ...workspace(), contextRef: 'ctx-other' } }), /task_conflict:context_mismatch/, 'one task id cannot drift across contexts')
const reverseRoot = mkdtempSync(join(tmpdir(), 'gotry-booking-reverse-context-'))
const reverseLedger = ensureLedger(reverseRoot)
const reverseRuntime = new BookingCopilotTaskRuntime(reverseLedger)
reverseRuntime.startTask({ ...turn('task-reverse-context'), workspace: { ...workspace(), contextRef: 'ctx-a' } })
assert.throws(() => reverseRuntime.startTask({ ...turn('task-reverse-context'), workspace: { ...workspace(), contextRef: 'ctx-b' } }), /task_conflict:context_mismatch/)
const terminalRoot = mkdtempSync(join(tmpdir(), 'gotry-booking-v2-terminal-replay-'))
const terminalLedger = ensureLedger(terminalRoot)
const terminalRuntime = new BookingCopilotTaskRuntime(terminalLedger)
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
const finalityRuntime = new BookingCopilotTaskRuntime(finalityLedger)
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
const longRuntime = new BookingCopilotTaskRuntime(longLedger)
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
const budgetRuntime = new BookingCopilotTaskRuntime(budgetLedger)
const budgetTaskId = 'task-operation-budget'
budgetRuntime.startTask(turn(budgetTaskId))
let twentiethContinuation: any
for (let ordinal = 1; ordinal <= 20; ordinal++) {
  const currentTurn = { ...turn(budgetTaskId), turnId: `budget-turn-${ordinal}` }
  if (ordinal > 1) budgetRuntime.startTask(currentTurn)
  const operation = budgetRuntime.issueOperation(budgetTaskId, action(`budget-action-${ordinal}`))
  const continuation = { schemaVersion: 'booking.surface' as const, kind: 'action.receipt.continuation' as const, taskId: budgetTaskId, workspace: workspace(0), receipt: budgetRuntime.withReceiptDigest({
    schemaVersion: 'booking.surface' as const, kind: 'action.receipt' as const, actionId: operation.action.actionId, contextRef: 'ctx-v2', status: 'applied' as const, revision: 0,
    observation: { kind: 'search.state' as const, resultCount: 0 }, resultContract: { outcome: 'complete' as const, hardCriteriaMet: true, factRefs: [], gapCodes: [], blockers: [], relaxationsApplied: [] },
  }) }
  const folded = budgetRuntime.continueWithReceipt(continuation)
  assert.equal(folded.operationCount, ordinal)
  if (ordinal === 19) assert.equal(folded.phase, 'planning', '19th receipt remains continuable')
  if (ordinal === 20) { assert.equal(folded.phase, 'terminal'); twentiethContinuation = continuation }
}
assert.equal(budgetRuntime.resumeTask(budgetTaskId)?.operationCount, 20)
assert.equal((budgetLedger.db.prepare("SELECT COUNT(*) AS n FROM events WHERE kind = 'booking.copilot.event.emitted' AND json_extract(payload, '$.eventKind') = 'terminal'").get() as { n: number }).n, 1, '20th receipt emits one durable terminal event')
const terminalBatchCount = budgetLedger.countEvents()
const terminalBatchBytes = (budgetLedger.db.prepare('SELECT COALESCE(SUM(length(payload)), 0) AS n FROM events').get() as { n: number }).n
const budgetRestart = new BookingCopilotTaskRuntime(ensureLedger(budgetRoot))
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
const bindingRuntime = new BookingCopilotTaskRuntime(ensureLedger(bindingRoot))
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
const legacyRuntime = new BookingCopilotTaskRuntime(legacyLedger)
legacyRuntime.startTask(turn('task-legacy-ordinal'))
const legacyOperation = legacyRuntime.issueOperation('task-legacy-ordinal', action('legacy-action'))
legacyLedger.db.prepare("UPDATE events SET payload = json_remove(payload, '$.operationCount') WHERE kind = 'booking.copilot.action.issued'").run()
const legacyReceipt = legacyRuntime.withReceiptDigest({ schemaVersion: 'booking.surface', kind: 'action.receipt', actionId: legacyOperation.action.actionId, contextRef: 'ctx-v2', status: 'applied', revision: 0, observation: { kind: 'search.state', resultCount: 0 }, resultContract: { outcome: 'complete', hardCriteriaMet: true, factRefs: [], gapCodes: [], blockers: [], relaxationsApplied: [] } })
legacyRuntime.continueWithReceipt({ schemaVersion: 'booking.surface', kind: 'action.receipt.continuation', taskId: 'task-legacy-ordinal', workspace: workspace(0), receipt: legacyReceipt })
legacyLedger.db.prepare("UPDATE events SET payload = json_remove(payload, '$.operationCount') WHERE kind = 'booking.copilot.receipt.observed'").run()
const legacyRestart = new BookingCopilotTaskRuntime(ensureLedger(legacyRoot))
assert.equal(legacyRestart.resumeTask('task-legacy-ordinal')?.operationCount, 1, 'legacy action and receipt rows recover operation ordinal')
legacyRestart['ledger'].close(); legacyLedger.close(); rmSync(legacyRoot, { recursive: true, force: true })

const ordinalTamperRoot = mkdtempSync(join(tmpdir(), 'gotry-booking-v2-ordinal-tamper-'))
const ordinalTamperLedger = ensureLedger(ordinalTamperRoot)
const ordinalTamperRuntime = new BookingCopilotTaskRuntime(ordinalTamperLedger)
ordinalTamperRuntime.startTask(turn('task-ordinal-tamper'))
ordinalTamperRuntime.issueOperation('task-ordinal-tamper', action('ordinal-action'))
ordinalTamperLedger.db.prepare("UPDATE events SET payload = json_set(payload, '$.operationCount', 7) WHERE kind = 'booking.copilot.action.issued'").run()
const ordinalRestart = new BookingCopilotTaskRuntime(ensureLedger(ordinalTamperRoot))
assert.throws(() => ordinalRestart.resumeTask('task-ordinal-tamper'), /ledger_corrupt:task-ordinal-tamper:action/, 'inconsistent explicit operation ordinal is rejected')
ordinalRestart['ledger'].close(); ordinalTamperLedger.close(); rmSync(ordinalTamperRoot, { recursive: true, force: true })

// A pre-versioned ledger family omitted offer versions from every persisted
// workspace, action, receipt and availability object. Rebuild the exact old
// digests, rather than only deleting one field, so replay proves migration of
// the row family and not a versioned fixture with a missing leaf.
type LegacyPayload = Record<string, unknown> & { action?: Record<string, unknown>; receipt?: ActionReceipt; workspace?: Record<string, unknown>; availability?: Record<string, unknown> }
const rewriteLegacyOfferRows = (ledger: ReturnType<typeof ensureLedger>, taskId: string, text: string, scalarVerifiedOfferRef?: string): void => {
  const rows = ledger.db.prepare("SELECT seq, kind, payload FROM events WHERE run_id = ? ORDER BY seq").all(taskId) as Array<{ seq: number; kind: string; payload: string }>
  const actionKinds = new Map<string, string>()
  const actionWorkspaceDigests = new Map<string, string>()
  const workspaceDigestMigration = new Map<string, string>()
  let currentWorkspace: Record<string, unknown> | undefined
  for (const row of rows) {
    if (row.kind !== 'booking.copilot.action.issued') continue
    const payload = JSON.parse(row.payload) as LegacyPayload
    const action = payload.action
    if (action && typeof action.actionId === 'string' && typeof action.kind === 'string') actionKinds.set(action.actionId, action.kind)
  }
  for (const row of rows) {
    const payload = JSON.parse(row.payload) as LegacyPayload
    const receiptActionId = row.kind === 'booking.copilot.receipt.observed' && payload.receipt && typeof payload.receipt.actionId === 'string' ? payload.receipt.actionId : undefined
    if (payload.workspace && typeof payload.workspace === 'object') {
      const versionedWorkspace = structuredClone(payload.workspace)
      const oldWorkspace = legacyWorkspace(payload.workspace as unknown as BookingWorkspaceSnapshot, scalarVerifiedOfferRef)
      payload.workspace = oldWorkspace
      const oldDigest = oldWorkspaceDigest(oldWorkspace)
      workspaceDigestMigration.set(oldWorkspaceDigest(versionedWorkspace as Record<string, unknown>), oldDigest)
      payload.workspaceDigest = oldDigest
      payload.workspaceSemanticDigest = oldWorkspaceSemanticDigest(oldWorkspace)
      currentWorkspace = oldWorkspace
    }
    if (payload.availability && typeof payload.availability === 'object') {
      const actionId = payload.action && typeof payload.action === 'object' && typeof payload.action.actionId === 'string' ? payload.action.actionId : undefined
      const availabilityValue = structuredClone(payload.availability) as Record<string, unknown>
      const sourceWorkspaceDigest: string | undefined = (() => {
        const hotels = availabilityValue.hotels
        if (!hotels || typeof hotels !== 'object' || Array.isArray(hotels)) return undefined
        for (const hotel of Object.values(hotels as Record<string, unknown>)) {
          if (!hotel || typeof hotel !== 'object' || Array.isArray(hotel)) continue
          const generation = (hotel as Record<string, unknown>).currentGeneration
          if (!generation || typeof generation !== 'object' || Array.isArray(generation)) continue
          const source = (generation as Record<string, unknown>).source
          if (source && typeof source === 'object' && !Array.isArray(source) && (source as Record<string, unknown>).kind === 'workspace_snapshot' && typeof (source as Record<string, unknown>).workspaceDigest === 'string') return (source as Record<string, unknown>).workspaceDigest as string
        }
        return undefined
      })()
      const sourceDigest = workspaceDigestMigration.get(sourceWorkspaceDigest ?? '') ?? (receiptActionId ? actionWorkspaceDigests.get(receiptActionId) : currentWorkspace ? oldWorkspaceDigest(currentWorkspace) : undefined)
      const oldAvailability = legacyAvailability(payload.availability, sourceDigest)
      payload.availability = oldAvailability
      payload.availabilityDigest = bookingDigest(oldAvailability)
      if (actionId) actionWorkspaceDigests.set(actionId, currentWorkspace ? oldWorkspaceDigest(currentWorkspace) : '')
    }
    if (row.kind === 'booking.copilot.user.turn.observed' && typeof payload.turnId === 'string' && payload.workspace && typeof payload.workspace === 'object') {
      payload.requestDigest = legacyTurnDigest(taskId, payload.turnId, payload.workspace, text)
    }
    if (row.kind === 'booking.copilot.action.issued' && payload.action && typeof payload.action === 'object') {
      const oldAction = payload.action
      const input = oldAction.input
      if (input && typeof input === 'object' && !Array.isArray(input) && ['offer.select', 'offer.check', 'checkout.prepare'].includes(String(oldAction.kind))) {
        delete (input as Record<string, unknown>).offerVersionRef
      }
      if (input && typeof input === 'object' && !Array.isArray(input)) oldAction.inputDigest = bookingDigest(input)
      const { actionDigest: _oldActionDigest, ...actionBase } = oldAction
      oldAction.actionDigest = bookingDigest(actionBase)
    }
    if (row.kind === 'booking.copilot.receipt.observed' && payload.receipt && typeof payload.receipt === 'object') {
      const actionId = typeof payload.receipt.actionId === 'string' ? payload.receipt.actionId : ''
      const oldReceipt = stripLegacyReceipt(payload.receipt)
      if (actionKinds.get(actionId) === 'checkout.prepare' && oldReceipt.observation && typeof oldReceipt.observation === 'object') {
        // A pre-versioned checkout carried only the legacy scalar verification
        // ref. It must never be upgraded into a live version capability.
        ;(oldReceipt.observation as Record<string, unknown>).verifiedOfferRef = scalarVerifiedOfferRef
      }
      payload.receipt = oldReceipt as unknown as ActionReceipt
      payload.receiptDigest = bookingDigest(oldReceipt)
    }
    if (row.kind === 'booking.copilot.decision.batch' && Array.isArray(payload.events)) {
      payload.events = payload.events.map((event) => {
        if (!event || typeof event !== 'object' || Array.isArray(event)) return event
        const oldEvent = event as Record<string, unknown>
        if (oldEvent.kind !== 'operation' || !oldEvent.action || typeof oldEvent.action !== 'object' || Array.isArray(oldEvent.action)) return oldEvent
        const oldAction = oldEvent.action as Record<string, unknown>
        const input = oldAction.input
        if (input && typeof input === 'object' && !Array.isArray(input) && ['offer.select', 'offer.check', 'checkout.prepare'].includes(String(oldAction.kind))) delete (input as Record<string, unknown>).offerVersionRef
        return oldEvent
      })
    }
    ledger.db.prepare('UPDATE events SET payload = ? WHERE seq = ?').run(JSON.stringify(payload), row.seq)
  }
}

// F1 same-revision replay guard regression: a TURN row written by an old
// public startTask (no live-time same-revision guard) must not silently
// rewrite the durable workspace semantic digest at the same revision. Replay
// must fail closed as a typed ledger_corrupt diagnostic instead of turning
// the replayed workspace into checkout authority. The deliberate
// replayUpgradeRequired reanchor and confirmed-state strong rejection stay
// intact; an unchanged same-revision TURN pair still replays normally.
//
// Lifecycle: every root/ledger is registered BEFORE any assertion so the
// finally block can close + remove it even if the assertion throws (a
// throw is exactly what regression tests must handle). f1MakeRoot
// registers the path immediately after mkdtemp; f1Open registers the
// ledger immediately after ensureLedger; f1Close closes once and
// unregisters.
const f1Roots: Set<string> = new Set()
const f1Ledgers: Set<ReturnType<typeof ensureLedger>> = new Set()
const f1MakeRoot = (prefix: string): string => { const r = mkdtempSync(join(tmpdir(), prefix)); f1Roots.add(r); return r }
const f1Open = (root: string): ReturnType<typeof ensureLedger> => { const l = ensureLedger(root); f1Ledgers.add(l); return l }
const f1Close = (ledger: ReturnType<typeof ensureLedger>): void => { if (!f1Ledgers.has(ledger)) return; ledger.close(); f1Ledgers.delete(ledger) }
const f1DriftVariants = [
  {
    name: 'verifiedOffer-injected',
    drift: (baseline: BookingWorkspaceSnapshot): BookingWorkspaceSnapshot => ({ ...baseline, verifiedOffer: verifiedCapability('offer-f1', 'offer-f1:v1', '2026-09-01T10:15:00.000Z') }),
  },
  {
    name: 'loadedOffer-version-drift',
    drift: (baseline: BookingWorkspaceSnapshot): BookingWorkspaceSnapshot => ({ ...baseline, loadedOffers: [loadedOffer('offer-f1', 'hotel-f1', 'offer-f1:v2')] }),
  },
  {
    name: 'selectedOffer-cleared',
    drift: (baseline: BookingWorkspaceSnapshot): BookingWorkspaceSnapshot => ({ ...baseline, selectedOfferRef: undefined, shortlistedOfferRefs: [] }),
  },
  {
    name: 'hotel-renamed',
    drift: (baseline: BookingWorkspaceSnapshot): BookingWorkspaceSnapshot => ({ ...baseline, visibleHotels: [{ ...baseline.visibleHotels[0]!, name: 'F1 Hotel Renamed' }] }),
  },
] as const
try {
for (const variant of f1DriftVariants) {
  const root = f1MakeRoot(`gotry-booking-v2-f1-replay-${variant.name}-`)
  const ledger = f1Open(root)
  const taskId = `task-f1-replay-${variant.name}`
  const baseline: BookingWorkspaceSnapshot = {
    ...workspace(0),
    visibleHotels: [{ hotelRef: 'hotel-f1', name: 'F1 Hotel', factRefs: [] }],
    loadedOffers: [loadedOffer('offer-f1', 'hotel-f1')],
    shortlistedOfferRefs: ['offer-f1'], selectedOfferRef: 'offer-f1',
  }
  const writer = new BookingCopilotTaskRuntime(ledger, { contextRefFactory: () => 'ctx-v2', now: () => '2026-09-01T10:00:00.000Z' })
  writer.startTask({ ...turn(taskId), workspace: baseline })
  // Simulate a TURN row persisted by an old public startTask that did not
  // enforce the same-revision semantic CAS. We bypass live guards and
  // append the drifted TURN row directly through the private appendTurn,
  // which writes the row with the drifted workspace and its own digests.
  const drifted = variant.drift(baseline)
  const driftedWorkspaceDigest = oldWorkspaceDigest(drifted as unknown as Record<string, unknown>)
  const driftedSemanticDigest = oldWorkspaceSemanticDigest(drifted as unknown as Record<string, unknown>)
  const driftedRequestDigest = bookingDigest({ schemaVersion: 'booking.surface', kind: 'user.turn', taskId, turnId: `${variant.name}-turn`, workspace: drifted, request: { text: 'continue with the injected variant' } })
  ;(writer as unknown as { appendTurn: (taskId: string, contextRef: string, requestDigest: string, workspaceDigest: string, workspaceSemanticDigest: string, ordinal: number, turnId: string, workspace: BookingWorkspaceSnapshot) => void }).appendTurn(taskId, 'ctx-v2', driftedRequestDigest, driftedWorkspaceDigest, driftedSemanticDigest, 2, `${variant.name}-turn`, drifted)
  // Close the writer before opening the restart reader so SQLite handles
  // never overlap; the restart is a fresh runtime against the same
  // durable root in the same process.
  f1Close(ledger)
  const restartedLedger = f1Open(root)
  const reader = new BookingCopilotTaskRuntime(restartedLedger, { contextRefFactory: () => 'ctx-v2', now: () => '2026-09-01T10:00:00.000Z' })
  const eventsBeforeResume = restartedLedger.countEvents()
  assert.throws(() => reader.resumeTask(taskId), new RegExp(`ledger_corrupt:${taskId}:same_revision_turn_workspace_drift`), `${variant.name} same-rev drift is fail-closed on replay`)
  // Business-authority refusal: the same drifted ledger must also refuse a
  // public checkout.prepare with the exact new drift diagnostic, and must
  // not advance durable event count (no checkout row written).
  const eventsAfterResume = restartedLedger.countEvents()
  assert.equal(eventsAfterResume, eventsBeforeResume, `${variant.name} fail-closed replay does not write additional events`)
  assert.throws(() => reader.issueOperation(taskId, { ...action(`f1-${variant.name}-checkout`), kind: 'checkout.prepare' as const, input: { offerRef: 'offer-f1', offerVersionRef: 'offer-f1:v1', verifiedOfferRef: 'verified-offer-f1' } }), new RegExp(`ledger_corrupt:${taskId}:same_revision_turn_workspace_drift`), `${variant.name} public checkout.prepare is refused with same-rev drift diagnostic`)
  const eventsAfterCheckout = restartedLedger.countEvents()
  assert.equal(eventsAfterCheckout, eventsBeforeResume, `${variant.name} refused checkout.prepare writes no event`)
  f1Close(restartedLedger)
}
// Positive: an unchanged snapshot at the same revision (just a different
// turn identity and request text) is still accepted on replay. This is the
// normal turn-by-turn conversation pattern under the same workspace.
{
  const root = f1MakeRoot('gotry-booking-v2-f1-replay-snapshot-stable-')
  const ledger = f1Open(root)
  const taskId = 'task-f1-replay-snapshot-stable'
  const baseline: BookingWorkspaceSnapshot = {
    ...workspace(0),
    visibleHotels: [{ hotelRef: 'hotel-f1', name: 'F1 Hotel', factRefs: [] }],
    loadedOffers: [loadedOffer('offer-f1', 'hotel-f1')],
    shortlistedOfferRefs: ['offer-f1'], selectedOfferRef: 'offer-f1',
  }
  const writer = new BookingCopilotTaskRuntime(ledger, { contextRefFactory: () => 'ctx-v2', now: () => '2026-09-01T10:00:00.000Z' })
  writer.startTask({ ...turn(taskId), workspace: baseline })
  writer.startTask({ ...turn(taskId), turnId: 'snapshot-stable-second-turn', workspace: baseline, request: { text: 'find hotels in Dubai again' } })
  f1Close(ledger)
  const restartedLedger = f1Open(root)
  const reader = new BookingCopilotTaskRuntime(restartedLedger, { contextRefFactory: () => 'ctx-v2' })
  const replayed = reader.resumeTask(taskId)
  assert.equal(replayed?.userTurnCount, 2, 'same-snapshot same-rev TURN pair survives replay')
  assert.equal(replayed?.lastTurnId, 'snapshot-stable-second-turn', 'last turn id reflects the snapshot-stable second turn')
  assert.equal(replayed?.workspaceSnapshot?.selectedOfferRef, 'offer-f1', 'unchanged snapshot retains its selected offer ref')
  f1Close(restartedLedger)
}
// Positive: the explicit replayUpgradeRequired reanchor keeps accepting a
// same-rev drifted TURN row. The legacy-tail replan path is set by an
// ACTION/RECEIPT gap; once replayUpgradeRequired is true, the next public
// TURN row may rewrite the durable workspace semantic digest and clear the
// reanchor flag. We use the public startTask path with a renamed visible
// hotel snapshot (the legitimate reanchor), then close/reopen and assert
// the reconstructed state.
{
  const root = f1MakeRoot('gotry-booking-v2-f1-replay-upgrade-')
  let ledger = f1Open(root)
  const taskId = 'task-f1-replay-upgrade-anchor'
  const baseline: BookingWorkspaceSnapshot = {
    ...workspace(0),
    visibleHotels: [{ hotelRef: 'hotel-f1', name: 'F1 Hotel', factRefs: [] }],
    loadedOffers: [loadedOffer('offer-f1', 'hotel-f1')],
    shortlistedOfferRefs: ['offer-f1'], selectedOfferRef: 'offer-f1',
  }
  const writer = new BookingCopilotTaskRuntime(ledger, { contextRefFactory: () => 'ctx-v2', now: () => '2026-09-01T10:00:00.000Z' })
  writer.startTask({ ...turn(taskId), workspace: baseline })
  const check = writer.issueOperation(taskId, { ...action('f1-replay-check'), kind: 'offer.check' as const, input: { offerRef: 'offer-f1', offerVersionRef: 'offer-f1:v1' } })
  // The receipt's blocker lineage must trigger replanAfterReplayUpgradeGap on
  // replay. We follow the existing legacyBlockerRoot pattern: write a normal
  // receipt with checkedOfferVersionRef, then strip the version field with
  // rewriteLegacyOfferRows so normalizeReceiptForReplay sees a legacy shape
  // and the digest mismatch fires the replan.
  const blockerReceipt = writer.withReceiptDigest({
    schemaVersion: 'booking.surface', kind: 'action.receipt', actionId: check.action.actionId, contextRef: 'ctx-v2',
    status: 'needs_input', revision: 1,
    observation: { kind: 'offer.availability', offerRef: 'offer-f1', checkedOfferVersionRef: 'offer-f1:v1', available: false, changedFactRefs: [], gapCodes: [] },
    resultContract: { outcome: 'partial', hardCriteriaMet: false, factRefs: ['fact-f1'], gapCodes: ['criterion_must_not_met'],
      blockers: [{ blockerId: 'f1-replay-blocker', sourceActionId: check.action.actionId, sourceReceiptDigest: '', scope: 'availability', code: 'criterion_must_not_met', criterionPath: 'offers.freeCancellation', strength: 'must', valueDigest: 'c'.repeat(64), evidence: { factRefs: ['fact-f1'], gapCodes: ['criterion_must_not_met'] } }],
      relaxationsApplied: [] },
  })
  writer.continueWithReceipt({ schemaVersion: 'booking.surface', kind: 'action.receipt.continuation', taskId, workspace: { ...baseline, revision: 1 }, receipt: blockerReceipt })
  rewriteLegacyOfferRows(ledger, taskId, 'find hotels in Dubai')
  f1Close(ledger)
  // First resume: replan sets replayUpgradeRequired (the established
  // pattern for setting up replayUpgradeRequired; root public old-public
  // probe independently proved origin).
  const reopenedLedger = f1Open(root)
  const reader = new BookingCopilotTaskRuntime(reopenedLedger, { contextRefFactory: () => 'ctx-v2' })
  const recovered = reader.resumeTask(taskId)
  assert.equal(recovered?.replayUpgradeRequired, true, 'legacy blocker lineage replan sets replayUpgradeRequired')
  f1Close(reopenedLedger)
  // Apply the legitimate reanchor via PUBLIC startTask while
  // replayUpgradeRequired is set; the reanchor TURN row rewrites the
  // durable semantic digest and clears the flag.
  ledger = f1Open(root)
  const reanchorWriter = new BookingCopilotTaskRuntime(ledger, { contextRefFactory: () => 'ctx-v2', now: () => '2026-09-01T10:00:00.000Z' })
  const reanchorWorkspace: BookingWorkspaceSnapshot = { ...baseline, revision: 1, visibleHotels: [{ hotelRef: 'hotel-f1', name: 'F1 Reanchored Hotel', factRefs: [] }] }
  reanchorWriter.startTask({ ...turn(taskId, 1), turnId: 'f1-replay-reanchor-turn', workspace: reanchorWorkspace, request: { text: 're-anchor after blocker' } })
  f1Close(ledger)
  const finalLedger = f1Open(root)
  const finalReader = new BookingCopilotTaskRuntime(finalLedger, { contextRefFactory: () => 'ctx-v2' })
  const upgraded = finalReader.resumeTask(taskId)
  assert.equal(upgraded?.workspaceSnapshot?.visibleHotels?.[0]?.name, 'F1 Reanchored Hotel', 'replayUpgradeRequired allows the same-rev reanchor drift via public startTask')
  assert.equal(upgraded?.replayUpgradeRequired, undefined, 'validated reanchor TURN clears replayUpgradeRequired')
  f1Close(finalLedger)
}
} finally {
  const closeErrors: unknown[] = []
  for (const open of [...f1Ledgers]) {
    try { open.close() } catch (e) { closeErrors.push(e) }
    f1Ledgers.delete(open)
  }
  for (const root of [...f1Roots]) {
    try { rmSync(root, { recursive: true, force: true }) } catch (e) { closeErrors.push(e) }
    f1Roots.delete(root)
  }
  if (closeErrors.length) throw new AggregateError(closeErrors, 'f1 fixture cleanup failed')
}

const legacyOfferRoot = mkdtempSync(join(tmpdir(), 'gotry-booking-v2-legacy-offer-version-'))
const legacyOfferLedger = ensureLedger(legacyOfferRoot)
const legacyOfferRuntime = new BookingCopilotTaskRuntime(legacyOfferLedger, { contextRefFactory: () => 'ctx-v2' })
const legacyWorkspace0: BookingWorkspaceSnapshot = { ...workspace(0), visibleHotels: [{ hotelRef: 'legacy-hotel', name: 'Legacy Hotel', factRefs: [] }], loadedOffers: [loadedOffer('legacy-offer-a', 'legacy-hotel'), loadedOffer('legacy-offer-b', 'legacy-hotel')], selectedOfferRef: 'legacy-offer-a', shortlistedOfferRefs: ['legacy-offer-a', 'legacy-offer-b'] }
const legacyWorkspace1: BookingWorkspaceSnapshot = { ...legacyWorkspace0, revision: 1, loadedOffers: [{ ...loadedOffer('legacy-offer-a', 'legacy-hotel', 'legacy-offer-a:v2'), factRefs: ['price'] }, loadedOffer('legacy-offer-b', 'legacy-hotel')] }
const legacyOfferTask = legacyOfferRuntime.startTask({ ...turn('task-legacy-offer-version'), workspace: legacyWorkspace0 })
legacyOfferRuntime.issueOperation(legacyOfferTask.taskId, { ...action('legacy-offer-check-v1'), kind: 'offer.check' as const, input: { offerRef: 'legacy-offer-a', offerVersionRef: 'legacy-offer-a:v1' } })
legacyOfferRuntime.continueWithReceipt({ schemaVersion: 'booking.surface', kind: 'action.receipt.continuation', taskId: legacyOfferTask.taskId, workspace: legacyWorkspace1, receipt: { schemaVersion: 'booking.surface', kind: 'action.receipt', actionId: 'legacy-offer-check-v1', contextRef: 'ctx-v2', status: 'changed', revision: 1, observation: { kind: 'offer.availability', offerRef: 'legacy-offer-a', checkedOfferVersionRef: 'legacy-offer-a:v1', currentOfferVersionRef: 'legacy-offer-a:v2', available: true, changedFactRefs: ['price'], gapCodes: [] }, resultContract: { outcome: 'partial', hardCriteriaMet: false, factRefs: [], gapCodes: [], blockers: [], relaxationsApplied: [] } } })
legacyOfferRuntime.startTask({ ...turn('task-legacy-offer-version', 1), workspace: legacyWorkspace1, turnId: 'task-legacy-offer-version-turn-1' })
legacyOfferRuntime.issueOperation(legacyOfferTask.taskId, { ...action('legacy-offer-check-v2', 1), kind: 'offer.check' as const, input: { offerRef: 'legacy-offer-a', offerVersionRef: 'legacy-offer-a:v2' } })
rewriteLegacyOfferRows(legacyOfferLedger, legacyOfferTask.taskId, 'find hotels in Dubai')
const legacyOfferRestart = new BookingCopilotTaskRuntime(ensureLedger(legacyOfferRoot), { contextRefFactory: () => 'ctx-v2' })
const legacyOfferRecovered = legacyOfferRestart.resumeTask(legacyOfferTask.taskId)
assert.ok(legacyOfferRecovered && legacyOfferRecovered.pendingAction?.input.offerVersionRef, 'pre-versioned row family migrates to a version-bound pending action')
assert.deepEqual(legacyOfferRecovered?.availability.attempts.map((attempt) => attempt.offerVersionRef), ['legacy-offer-version:' + bookingDigest({ contextRef: 'ctx-v2', offerRef: 'legacy-offer-a', hotelRef: 'legacy-hotel', evidenceLevel: 'rate_loaded', factRefs: [] }).slice(0, 40), 'legacy-offer-version:' + bookingDigest({ contextRef: 'ctx-v2', offerRef: 'legacy-offer-a', hotelRef: 'legacy-hotel', evidenceLevel: 'rate_loaded', factRefs: ['price'] }).slice(0, 40)], 'legacy A attempts retain distinct old v1 and changed v2 identities')
legacyOfferRestart['ledger'].close(); legacyOfferLedger.close(); rmSync(legacyOfferRoot, { recursive: true, force: true })

// An unsafe legacy checkout tail must not resurrect a scalar verifiedOfferRef
// or strand the task behind terminal/error events written by the old runtime.
// The upgrader skips that tail, preserves ordinals/sequences, then permits a
// new typed turn and a new version-bound check to append after restart.
const legacyCheckoutRoot = mkdtempSync(join(tmpdir(), 'gotry-booking-v2-legacy-checkout-tail-'))
const legacyCheckoutLedger = ensureLedger(legacyCheckoutRoot)
const legacyCheckoutRuntime = new BookingCopilotTaskRuntime(legacyCheckoutLedger, { contextRefFactory: () => 'ctx-v2', now: () => '2026-09-01T10:00:00.000Z' })
const legacyCheckoutCapability = verifiedCapability('legacy-checkout', 'legacy-checkout:v1')
const legacyCheckoutWorkspace: BookingWorkspaceSnapshot = { ...workspace(1), visibleHotels: [{ hotelRef: 'legacy-checkout-hotel', name: 'Legacy Checkout Hotel', factRefs: [] }], loadedOffers: [loadedOffer('legacy-checkout', 'legacy-checkout-hotel')], selectedOfferRef: 'legacy-checkout', verifiedOffer: legacyCheckoutCapability }
const legacyCheckoutTask = legacyCheckoutRuntime.startTask({ ...turn('task-legacy-checkout-tail'), workspace: legacyCheckoutWorkspace })
const legacyCheckoutAction = { ...action('legacy-checkout-action', 1), kind: 'checkout.prepare' as const, input: { offerRef: 'legacy-checkout', offerVersionRef: 'legacy-checkout:v1', verifiedOfferRef: legacyCheckoutCapability.verifiedOfferRef } }
const legacyCheckoutBatch = legacyCheckoutRuntime.applyDecisionBatch(legacyCheckoutTask.taskId, 'legacy-checkout-batch', [{ kind: 'operation', action: legacyCheckoutAction }, { kind: 'explanation', explanation: { text: 'checkout handoff is awaiting receipt', factRefs: [] } }], true)
assert.equal(legacyCheckoutBatch.some((event) => event.kind === 'operation' && event.action.actionId === legacyCheckoutAction.actionId), true, 'normal decision batch includes the checkout operation envelope')
const appendLegacyEvent = (eventId: string, sequence: number, eventKind: 'terminal' | 'error'): void => {
  const safeContent = eventKind === 'terminal' ? { status: 'stopped' as const, summary: 'legacy-terminal', factRefs: [] } : { code: 'unhandled', message: 'legacy error', retryable: false }
  legacyCheckoutLedger.insertEvent({ actor: 'system:booking-copilot', kind: 'booking.copilot.event.emitted', subjectId: legacyCheckoutTask.taskId, runId: legacyCheckoutTask.taskId, ts: '2026-09-01T10:00:01.000Z', idemKey: `legacy-tail:${eventId}`, payload: { schema: 'booking.copilot.ledger', taskId: legacyCheckoutTask.taskId, contextRef: 'ctx-v2', eventId, sequence, emittedAt: '2026-09-01T10:00:01.000Z', eventKind, contentDigest: bookingDigest(safeContent) } })
}
appendLegacyEvent('legacy-terminal-event', 6, 'terminal')
appendLegacyEvent('legacy-error-event', 7, 'error')
rewriteLegacyOfferRows(legacyCheckoutLedger, legacyCheckoutTask.taskId, 'find hotels in Dubai', legacyCheckoutCapability.verifiedOfferRef)
const legacyCheckoutNextWorkspace: BookingWorkspaceSnapshot = { ...legacyCheckoutWorkspace, revision: 2, verifiedOffer: undefined }
;(legacyCheckoutRuntime as unknown as { appendTurn: (taskId: string, contextRef: string, requestDigest: string, workspaceDigest: string, workspaceSemanticDigest: string, ordinal: number, turnId: string, workspace: BookingWorkspaceSnapshot) => void }).appendTurn(legacyCheckoutTask.taskId, 'ctx-v2', bookingDigest({ schemaVersion: 'booking.surface', kind: 'user.turn', taskId: legacyCheckoutTask.taskId, turnId: 'legacy-checkout-next-turn', workspace: legacyCheckoutNextWorkspace, request: { text: 'check the replacement room' } }), oldWorkspaceDigest(legacyCheckoutNextWorkspace as unknown as Record<string, unknown>), oldWorkspaceSemanticDigest(legacyCheckoutNextWorkspace as unknown as Record<string, unknown>), 2, 'legacy-checkout-next-turn', legacyCheckoutNextWorkspace)
const legacyCheckoutRestart = new BookingCopilotTaskRuntime(ensureLedger(legacyCheckoutRoot), { contextRefFactory: () => 'ctx-v2', now: () => '2026-09-01T10:00:00.000Z' })
const legacyCheckoutRecovery = legacyCheckoutRestart.resumeTask(legacyCheckoutTask.taskId)
assert.equal(legacyCheckoutRecovery?.workspaceSnapshot?.verifiedOffer, undefined, 'legacy scalar verifiedOfferRef never becomes a live capability')
assert.equal(legacyCheckoutRecovery?.phase, 'planning', 'unsafe legacy checkout tail suppresses old terminal/error events and replans')
assert.equal(legacyCheckoutRecovery?.operationCount, 1, 'legacy checkout action ordinal remains consumed after tail skip')
assert.ok((legacyCheckoutRecovery?.lastSequence ?? 0) >= 7, 'legacy terminal/error sequence remains consumed for append-only continuation')
legacyCheckoutRestart.issueOperation(legacyCheckoutTask.taskId, { ...action('legacy-checkout-recheck', 2), kind: 'offer.check' as const, input: { offerRef: 'legacy-checkout', offerVersionRef: 'legacy-checkout:v1' } })
const legacyCheckoutAfterAppend = legacyCheckoutRestart.resumeTask(legacyCheckoutTask.taskId)
assert.equal(legacyCheckoutAfterAppend?.phase, 'waiting_receipt', 'new typed offer.check remains reachable after unsafe legacy tail')
assert.equal(legacyCheckoutAfterAppend?.operationCount, 2)
assert.equal(legacyCheckoutAfterAppend?.revision, 2)
const legacyCheckoutNewEvent = legacyCheckoutRestart.emitEvent(legacyCheckoutTask.taskId, { kind: 'explanation', explanation: { text: 'new anchor event', factRefs: [] } })
assert.equal(legacyCheckoutNewEvent.sequence, (legacyCheckoutAfterAppend?.lastSequence ?? 0) + 1, 'new post-reanchor event receives the next unique sequence')
legacyCheckoutRestart['ledger'].close(); legacyCheckoutLedger.close(); rmSync(legacyCheckoutRoot, { recursive: true, force: true })

// The DECISION_BATCH is a duplicate envelope around individually persisted
// EVENT/ACTION/EVENT rows. A clean legacy batch is replayable only when every
// envelope item points to the exact consumed identity/content; omissions,
// unknown identities, duplicate identities and content edits are corruption.
type BatchVariant = 'tampered' | 'missing' | 'unknown' | 'duplicate'
const legacyBatchVariantFixture = (variant: BatchVariant): { root: string; taskId: string } => {
  const root = mkdtempSync(join(tmpdir(), `gotry-booking-v2-legacy-batch-${variant}-`))
  const ledger = ensureLedger(root)
  const writer = new BookingCopilotTaskRuntime(ledger, { contextRefFactory: () => 'ctx-v2', now: () => '2026-09-01T10:00:00.000Z' })
  const taskId = `task-legacy-batch-${variant}`
  const capability = verifiedCapability(`batch-${variant}-offer`)
  const batchWorkspace: BookingWorkspaceSnapshot = { ...workspace(0), visibleHotels: [{ hotelRef: `batch-${variant}-hotel`, name: 'Batch Hotel', factRefs: [] }], loadedOffers: [loadedOffer(`batch-${variant}-offer`, `batch-${variant}-hotel`)], selectedOfferRef: `batch-${variant}-offer`, verifiedOffer: capability }
  writer.startTask({ ...turn(taskId), workspace: batchWorkspace })
  const batchAction = { ...action(`batch-${variant}-checkout`), kind: 'checkout.prepare' as const, input: { offerRef: `batch-${variant}-offer`, offerVersionRef: `batch-${variant}-offer:v1`, verifiedOfferRef: capability.verifiedOfferRef } }
  writer.applyDecisionBatch(taskId, `batch-envelope-${variant}`, [{ kind: 'operation', action: batchAction }, { kind: 'explanation', explanation: { text: 'batch envelope', factRefs: [] } }], true)
  rewriteLegacyOfferRows(ledger, taskId, 'find hotels in Dubai', capability.verifiedOfferRef)
  const row = ledger.db.prepare("SELECT seq, payload FROM events WHERE run_id = ? AND kind = 'booking.copilot.decision.batch'").get(taskId) as { seq: number; payload: string }
  const payload = JSON.parse(row.payload) as { events: Array<Record<string, unknown>> }
  if (variant === 'tampered') {
    const explanation = payload.events.find((event) => event.kind === 'explanation')
    if (explanation && explanation.explanation && typeof explanation.explanation === 'object') (explanation.explanation as Record<string, unknown>).text = 'edited envelope'
  } else if (variant === 'missing') {
    const operationIndex = payload.events.findIndex((event) => event.kind === 'operation')
    assert.ok(operationIndex >= 0, 'missing batch fixture has a retained operation identity to remove')
    payload.events.splice(operationIndex, 1)
  } else if (variant === 'unknown') {
    const first = payload.events[0]
    if (first) first.eventId = 'unknown-envelope-event'
  } else {
    const first = payload.events[0]
    if (first) payload.events.push(structuredClone(first))
  }
  ledger.db.prepare('UPDATE events SET payload = ? WHERE seq = ?').run(JSON.stringify(payload), row.seq)
  ledger.close()
  return { root, taskId }
}
for (const variant of ['tampered', 'missing', 'unknown', 'duplicate'] as const) {
  const fixtureState = legacyBatchVariantFixture(variant)
  const replayLedger = ensureLedger(fixtureState.root)
  const replay = new BookingCopilotTaskRuntime(replayLedger, { contextRefFactory: () => 'ctx-v2', now: () => '2026-09-01T10:00:00.000Z' })
  assert.throws(() => replay.resumeTask(fixtureState.taskId), new RegExp(`ledger_corrupt:${fixtureState.taskId}:decision_batch`), `legacy duplicate batch ${variant} mismatch fails closed`)
  replayLedger.close()
  rmSync(fixtureState.root, { recursive: true, force: true })
}

// Batch identity is scoped to its own envelope. A standalone EVENT/ACTION
// pair is completed before a normal batch, then a second unsafe legacy batch
// opens the migration skip tail. Replay must consume the first batch normally,
// validate the second against only its own individual rows, and reject a
// cross-batch event graft instead of accepting a globally consumed identity.
const legacyTwoBatchFixture = (crossBatchGraft: boolean): { root: string; taskId: string } => {
  const root = mkdtempSync(join(tmpdir(), `gotry-booking-v2-legacy-two-batch-${crossBatchGraft ? 'graft' : 'clean'}-`))
  const ledger = ensureLedger(root)
  const writer = new BookingCopilotTaskRuntime(ledger, { contextRefFactory: () => 'ctx-v2', now: () => '2026-09-01T10:00:00.000Z' })
  const taskId = `task-legacy-two-batch-${crossBatchGraft ? 'graft' : 'clean'}`
  const capability = verifiedCapability(`${taskId}-offer`)
  const initialWorkspace: BookingWorkspaceSnapshot = {
    ...workspace(0), visibleHotels: [{ hotelRef: `${taskId}-hotel`, name: 'Two Batch Hotel', factRefs: [] }],
    loadedOffers: [loadedOffer(`${taskId}-offer`, `${taskId}-hotel`)], selectedOfferRef: `${taskId}-offer`, verifiedOffer: capability,
  }
  writer.startTask({ ...turn(taskId), workspace: initialWorkspace })
  const standaloneStatus = writer.emitEvent(taskId, { kind: 'status', status: 'submitted' })
  const standaloneAction = writer.issueOperation(taskId, action(`${taskId}-standalone-action`))
  const standaloneReceipt = writer.withReceiptDigest({
    schemaVersion: 'booking.surface', kind: 'action.receipt', actionId: standaloneAction.action.actionId, contextRef: 'ctx-v2', status: 'applied', revision: 1,
    observation: { kind: 'search.state', resultCount: 0 }, resultContract: { outcome: 'complete', hardCriteriaMet: true, factRefs: [], gapCodes: [], blockers: [], relaxationsApplied: [] },
  })
  writer.continueWithReceipt({ schemaVersion: 'booking.surface', kind: 'action.receipt.continuation', taskId, workspace: { ...initialWorkspace, revision: 1 }, receipt: standaloneReceipt })
  const batchWorkspace: BookingWorkspaceSnapshot = {
    ...workspace(1), visibleHotels: [{ hotelRef: `${taskId}-hotel`, name: 'Two Batch Hotel', factRefs: [] }],
    loadedOffers: [loadedOffer(`${taskId}-offer`, `${taskId}-hotel`)], selectedOfferRef: `${taskId}-offer`, verifiedOffer: capability,
  }
  writer.startTask({ ...turn(taskId, 1), turnId: `${taskId}-anchor-turn`, workspace: batchWorkspace })
  const normalBatch = writer.applyDecisionBatch(taskId, `${taskId}-normal-batch`, [{ kind: 'explanation', explanation: { text: 'normal completed batch', factRefs: [] } }], true)
  assert.ok(normalBatch.some((event) => event.kind === 'explanation'), 'normal batch persists its own explanation')
  const unsafeAction = { ...action(`${taskId}-unsafe-checkout`, 1), kind: 'checkout.prepare' as const, input: { offerRef: `${taskId}-offer`, offerVersionRef: `${taskId}-offer:v1`, verifiedOfferRef: capability.verifiedOfferRef } }
  writer.applyDecisionBatch(taskId, `${taskId}-unsafe-batch`, [{ kind: 'operation', action: unsafeAction }, { kind: 'explanation', explanation: { text: 'unsafe legacy batch', factRefs: [] } }], true)
  rewriteLegacyOfferRows(ledger, taskId, 'find hotels in Dubai', capability.verifiedOfferRef)
  if (crossBatchGraft) {
    const rows = ledger.db.prepare("SELECT seq, payload FROM events WHERE run_id = ? AND kind = 'booking.copilot.decision.batch' ORDER BY seq").all(taskId) as Array<{ seq: number; payload: string }>
    assert.equal(rows.length, 2, 'two-batch fixture retains both decision envelopes')
    const firstPayload = JSON.parse(rows[0]!.payload) as { events: Array<Record<string, unknown>> }
    const secondPayload = JSON.parse(rows[1]!.payload) as { events: Array<Record<string, unknown>> }
    const graft = firstPayload.events.find((event) => event.kind === 'explanation')
    assert.ok(graft, 'first batch has an event identity available for graft detection')
    const graftIndex = secondPayload.events.findIndex((event) => event.kind === 'explanation')
    assert.ok(graftIndex >= 0, 'second batch has a retained event slot for graft detection')
    secondPayload.events[graftIndex] = structuredClone(graft)
    ledger.db.prepare('UPDATE events SET payload = ? WHERE seq = ?').run(JSON.stringify(secondPayload), rows[1]!.seq)
  }
  assert.equal(standaloneStatus.sequence < standaloneAction.sequence, true, 'standalone EVENT precedes standalone ACTION before batched work')
  ledger.close()
  return { root, taskId }
}
const cleanTwoBatch = legacyTwoBatchFixture(false)
const cleanTwoBatchReplayLedger = ensureLedger(cleanTwoBatch.root)
const cleanTwoBatchReplay = new BookingCopilotTaskRuntime(cleanTwoBatchReplayLedger, { contextRefFactory: () => 'ctx-v2', now: () => '2026-09-01T10:00:00.000Z' })
const cleanTwoBatchState = cleanTwoBatchReplay.resumeTask(cleanTwoBatch.taskId)
assert.equal(cleanTwoBatchState?.phase, 'planning', 'normal batch replays before unsafe legacy batch enters replan')
assert.equal(cleanTwoBatchState?.operationCount, 2, 'standalone action and unsafe batch action ordinals remain consumed')
cleanTwoBatchReplayLedger.close()
rmSync(cleanTwoBatch.root, { recursive: true, force: true })
const graftedTwoBatch = legacyTwoBatchFixture(true)
const graftedTwoBatchReplayLedger = ensureLedger(graftedTwoBatch.root)
const graftedTwoBatchReplay = new BookingCopilotTaskRuntime(graftedTwoBatchReplayLedger, { contextRefFactory: () => 'ctx-v2', now: () => '2026-09-01T10:00:00.000Z' })
assert.throws(() => graftedTwoBatchReplay.resumeTask(graftedTwoBatch.taskId), new RegExp(`ledger_corrupt:${graftedTwoBatch.taskId}:decision_batch`), 'cross-batch event graft fails closed within the second envelope')
graftedTwoBatchReplayLedger.close()
rmSync(graftedTwoBatch.root, { recursive: true, force: true })

// A safe pre-versioned offer.select/offer.check batch must be readable through
// both restart and the durable batch-replay API. The normalized operation is
// schema-valid and uses the same deterministic synthetic version that the
// workspace migration derives from the loaded offer facts.
for (const kind of ['offer.select', 'offer.check'] as const) {
  const root = mkdtempSync(join(tmpdir(), `gotry-booking-v2-legacy-safe-batch-${kind.replace('.', '-')}-`))
  const ledger = ensureLedger(root)
  const writer = new BookingCopilotTaskRuntime(ledger, { contextRefFactory: () => 'ctx-v2', now: () => '2026-09-01T10:00:00.000Z' })
  const taskId = `task-legacy-safe-batch-${kind.replace('.', '-')}`
  const offerRef = `${taskId}-offer`
  const hotelRef = `${taskId}-hotel`
  const safeWorkspace: BookingWorkspaceSnapshot = { ...workspace(0), visibleHotels: [{ hotelRef, name: 'Safe Batch Hotel', factRefs: [] }], loadedOffers: [loadedOffer(offerRef, hotelRef)] }
  writer.startTask({ ...turn(taskId), workspace: safeWorkspace })
  const safeAction = { ...action(`${taskId}-action`), kind, input: { offerRef, offerVersionRef: `${offerRef}:v1` } } as const
  const requestKey = `${taskId}-request`
  writer.applyDecisionBatch(taskId, requestKey, [{ kind: 'operation', action: safeAction }], true)
  rewriteLegacyOfferRows(ledger, taskId, 'find hotels in Dubai')
  ledger.close()
  const restartLedger = ensureLedger(root)
  const restart = new BookingCopilotTaskRuntime(restartLedger, { contextRefFactory: () => 'ctx-v2', now: () => '2026-09-01T10:00:00.000Z' })
  const recovered = restart.resumeTask(taskId)
  const recoveredOperation = recovered?.pendingAction
  const expectedVersion = `legacy-offer-version:${bookingDigest({ contextRef: 'ctx-v2', offerRef, hotelRef, evidenceLevel: 'rate_loaded', factRefs: [] }).slice(0, 40)}`
  const offerVersionFromAction = (candidate: { input: unknown } | undefined): string | undefined => {
    const input = candidate?.input
    return input && typeof input === 'object' && !Array.isArray(input) && 'offerVersionRef' in input && typeof input.offerVersionRef === 'string' ? input.offerVersionRef : undefined
  }
  assert.equal(recoveredOperation?.kind, kind, `legacy ${kind} batch restart retains operation kind`)
  assert.equal(offerVersionFromAction(recoveredOperation), expectedVersion, `legacy ${kind} batch restart binds deterministic synthetic version`)
  const replayBatch = restart.readDecisionBatch(taskId, requestKey)
  assert.ok(replayBatch, `legacy ${kind} batch is readable after restart`)
  const replayOperation = replayBatch?.find((event) => event.kind === 'operation')
  assert.ok(replayOperation && validateBookingSurface(replayOperation).ok, `legacy ${kind} batch operation is schema-valid after replay normalization`)
  assert.equal(replayOperation?.kind === 'operation' ? offerVersionFromAction(replayOperation.action) : undefined, expectedVersion, `legacy ${kind} batch replay operation carries synthetic version`)
  restartLedger.close()
  rmSync(root, { recursive: true, force: true })
}

// A legacy receipt whose normalization changes a blocker/approval lineage is
// unsafe to replay: it must enter an explicit replan gap, never be mislabeled
// as a corrupt ledger or silently recreate approval authority.
const legacyBlockerRoot = mkdtempSync(join(tmpdir(), 'gotry-booking-v2-legacy-blocker-replan-'))
const legacyBlockerLedger = ensureLedger(legacyBlockerRoot)
const legacyBlockerRuntime = new BookingCopilotTaskRuntime(legacyBlockerLedger, { contextRefFactory: () => 'ctx-v2' })
const blockerWorkspace0: BookingWorkspaceSnapshot = { ...workspace(0), visibleHotels: [{ hotelRef: 'blocker-hotel', name: 'Blocker Hotel', factRefs: [] }], loadedOffers: [loadedOffer('blocker-offer', 'blocker-hotel')] }
const blockerTask = legacyBlockerRuntime.startTask({ ...turn('task-legacy-blocker-lineage'), workspace: blockerWorkspace0 })
legacyBlockerRuntime.issueOperation(blockerTask.taskId, { ...action('legacy-blocker-check'), kind: 'offer.check' as const, input: { offerRef: 'blocker-offer', offerVersionRef: 'blocker-offer:v1' } })
const legacyLineageReceipt = legacyBlockerRuntime.withReceiptDigest({ schemaVersion: 'booking.surface', kind: 'action.receipt', actionId: 'legacy-blocker-check', contextRef: 'ctx-v2', status: 'needs_input', revision: 1, observation: { kind: 'offer.availability', offerRef: 'blocker-offer', checkedOfferVersionRef: 'blocker-offer:v1', available: false, changedFactRefs: [], gapCodes: [] }, resultContract: { outcome: 'partial', hardCriteriaMet: false, factRefs: ['fact-free-cancellation'], gapCodes: ['criterion_must_not_met'], blockers: [{ blockerId: 'legacy-blocker', sourceActionId: 'legacy-blocker-check', sourceReceiptDigest: '', scope: 'availability', code: 'criterion_must_not_met', criterionPath: 'offers.freeCancellation', strength: 'must', valueDigest: 'c'.repeat(64), evidence: { factRefs: ['fact-free-cancellation'], gapCodes: ['criterion_must_not_met'] } }], relaxationsApplied: [] } })
legacyBlockerRuntime.continueWithReceipt({ schemaVersion: 'booking.surface', kind: 'action.receipt.continuation', taskId: blockerTask.taskId, workspace: { ...blockerWorkspace0, revision: 1 }, receipt: legacyLineageReceipt })
rewriteLegacyOfferRows(legacyBlockerLedger, blockerTask.taskId, 'find hotels in Dubai')
const legacyBlockerRestart = new BookingCopilotTaskRuntime(ensureLedger(legacyBlockerRoot), { contextRefFactory: () => 'ctx-v2' })
const blockerRecovery = legacyBlockerRestart.resumeTask(blockerTask.taskId)
assert.equal(blockerRecovery?.phase, 'planning', 'normalized legacy blocker receipt fail-closes to replan')
assert.equal(blockerRecovery?.replayUpgradeRequired, true, 'legacy blocker lineage records an explicit replay upgrade gap')
assert.equal(blockerRecovery?.pendingAction, undefined)
assert.throws(() => legacyBlockerRestart.issueOperation(blockerTask.taskId, action('blocked-replan-action', 1)), /replay_upgrade|reanchor|replan|turn_required/, 'replay upgrade gap blocks direct operation before a new anchor turn')
assert.throws(() => legacyBlockerRestart.applyDecisionBatch(blockerTask.taskId, 'blocked-replan-batch', [{ kind: 'operation', action: action('blocked-replan-decision', 1) }]), /replay_upgrade|reanchor|replan|turn_required/, 'replay upgrade gap blocks decision batches before a new anchor turn')
assert.throws(() => legacyBlockerRestart.emitEvent(blockerTask.taskId, { kind: 'explanation', explanation: { text: 'must wait for a new anchor turn', factRefs: [] } }), /replay_upgrade|reanchor|replan|turn_required/, 'replay upgrade gap blocks standalone event mutation')
const blockedBindingTurn = { ...turn(blockerTask.taskId, 1), turnId: 'blocked-replan-binding-turn' }
assert.throws(() => legacyBlockerRestart.persistRequestBinding('blocked-replan-request', blockedBindingTurn, { requestKey: 'blocked-replan-request', principal: { subject: 'blocked-replan-principal', scope: 'booking:read' } }), /replay_upgrade|reanchor|replan|turn_required/, 'replay upgrade gap blocks request binding mutation')
assert.throws(() => legacyBlockerRestart.terminalDecisionBatch(blockerTask.taskId, 'blocked-replan-terminal-batch'), /replay_upgrade|reanchor|replan|turn_required|task_not_terminal/, 'replay upgrade gap blocks terminal decision mutation')
const reanchorWorkspace = blockerRecovery!.workspaceSnapshot!
const reanchor = legacyBlockerRestart.startTask({ ...turn(blockerTask.taskId, reanchorWorkspace.revision), turnId: 'legacy-blocker-reanchor-turn', workspace: reanchorWorkspace, request: { text: 're-anchor the upgraded workspace' } })
assert.equal(reanchor.replayUpgradeRequired, undefined, 'validated new TURN clears replay upgrade gap')
legacyBlockerRestart['ledger'].close(); legacyBlockerLedger.close(); rmSync(legacyBlockerRoot, { recursive: true, force: true })

// Once that legitimate checkout upgrade gap activates tail skipping, a later
// skipped ACTION is still validated. Inflated ordinals may not be hidden by
// Math.max while the runtime consumes the old tail.
const skippedActionRoot = mkdtempSync(join(tmpdir(), 'gotry-booking-v2-legacy-skipped-action-tamper-'))
const skippedActionLedger = ensureLedger(skippedActionRoot)
const skippedActionWriter = new BookingCopilotTaskRuntime(skippedActionLedger, { contextRefFactory: () => 'ctx-v2', now: () => '2026-09-01T10:00:00.000Z' })
const skippedWorkspace: BookingWorkspaceSnapshot = { ...workspace(0), visibleHotels: [{ hotelRef: 'skipped-hotel', name: 'Skipped Hotel', factRefs: [] }], loadedOffers: [loadedOffer('skipped-offer', 'skipped-hotel')], selectedOfferRef: 'skipped-offer', verifiedOffer: verifiedCapability('skipped-offer') }
const skippedTask = skippedActionWriter.startTask({ ...turn('task-legacy-skipped-action'), workspace: skippedWorkspace })
skippedActionWriter.issueOperation(skippedTask.taskId, { ...action('unsafe-checkout-tail'), kind: 'checkout.prepare' as const, input: { offerRef: 'skipped-offer', offerVersionRef: 'skipped-offer:v1', verifiedOfferRef: 'verified-skipped-offer' } })
rewriteLegacyOfferRows(skippedActionLedger, skippedTask.taskId, 'find hotels in Dubai', 'verified-skipped-offer')
skippedActionLedger.insertEvent({ actor: 'system:booking-copilot', kind: 'booking.copilot.event.emitted', subjectId: skippedTask.taskId, runId: skippedTask.taskId, ts: '2026-09-01T10:00:01.000Z', idemKey: 'skipped-action-tail-event', payload: { schema: 'booking.copilot.ledger', taskId: skippedTask.taskId, contextRef: 'ctx-v2', eventId: 'skipped-action-tail-event', sequence: 2, emittedAt: '2026-09-01T10:00:01.000Z', eventKind: 'error', contentDigest: bookingDigest({ code: 'unhandled', message: 'legacy error', retryable: false }) } })
const lateActionBase = { actionId: 'legacy-skipped-action', kind: 'search.run', contextRef: 'ctx-v2', expectedRevision: 0, factRefs: [], reasonDigest: bookingDigest('legacy search'), inputDigest: bookingDigest({}), input: {}, eventId: 'legacy-skipped-operation', sequence: 3, emittedAt: '2026-09-01T10:00:02.000Z', sourceTurnId: 'task-legacy-skipped-action-turn-0' }
const lateAction = { ...lateActionBase, actionDigest: bookingDigest(lateActionBase) }
const startAvailability = (JSON.parse((skippedActionLedger.db.prepare("SELECT payload FROM events WHERE run_id = ? AND kind = 'booking.copilot.task.started'").get(skippedTask.taskId) as { payload: string }).payload) as { availability: Record<string, unknown> }).availability
skippedActionLedger.insertEvent({ actor: 'system:booking-copilot', kind: 'booking.copilot.action.issued', subjectId: skippedTask.taskId, runId: skippedTask.taskId, ts: '2026-09-01T10:00:02.000Z', idemKey: 'legacy-skipped-action-row', payload: { schema: 'booking.copilot.ledger', taskId: skippedTask.taskId, contextRef: 'ctx-v2', action: lateAction, operationCount: 99, availability: legacyAvailability(startAvailability), availabilityDigest: bookingDigest(legacyAvailability(startAvailability)) } })
const skippedActionRestart = new BookingCopilotTaskRuntime(ensureLedger(skippedActionRoot), { contextRefFactory: () => 'ctx-v2', now: () => '2026-09-01T10:00:00.000Z' })
assert.throws(() => skippedActionRestart.resumeTask(skippedTask.taskId), /ledger_corrupt:task-legacy-skipped-action:action/, 'tampered skipped ACTION ordinal fails closed during legacy tail replay')
skippedActionRestart['ledger'].close(); skippedActionLedger.close(); rmSync(skippedActionRoot, { recursive: true, force: true })

const approvedReplay = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(approvedIngress) })
assert.equal(approvedReplay.status, 200)
assert.equal(await approvedReplay.text(), approvedBody, 'approved ingress retry replays the durable batch while waiting for receipt')
assert.equal(plannerCalls, 3, 'approved ingress replay does not call planner or append')
const alteredTextReplay = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify({ ...approvedIngress, request: { ...approvedIngress.request, text: 'different request' } }) })
assert.equal(alteredTextReplay.status, 409, 'altered request text cannot replay a waiting batch')
const alteredContextReplay = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify({ ...approvedIngress, contextRef: 'ctx-forged' }) })
assert.equal(alteredContextReplay.status, 400, 'browser context injection is rejected at ingress schema boundary')
const alteredApprovalReplay = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify({ ...approvedIngress, request: { ...approvedIngress.request, approval: { ...approved, to: 'drop' } } }) })
assert.equal(alteredApprovalReplay.status, 409, 'altered approval tuple cannot replay a waiting batch')
const alteredCapabilitiesReplay = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify({ ...approvedIngress, workspace: { ...approvedIngress.workspace, capabilities: { surface: 'tenant', allowedActions: ['search.run', 'search.run'] } } }) })
assert.equal(alteredCapabilitiesReplay.status, 400, 'browser capability injection is rejected at ingress schema boundary')
const ingressReplay = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify({ ...ingress, workspace: { ...ingress.workspace, revision: 2 }, request: { text: 'prefer a nearby match' } }) })
assert.equal(ingressReplay.status, 409, 'unbound ingress cannot replay an existing task')
assert.equal(plannerCalls, 3)
const staleHandshake = await fetch(endpoint, { method: 'POST', headers: { authorization: 'Bearer v2-server-key', 'content-type': 'application/json', 'x-booking-surface-version': 'booking.surface.retired', 'x-booking-surface-schema-sha256': '0'.repeat(64) }, body: JSON.stringify({ ...turn('task-server'), workspace: { ...workspace(1), contextRef: 'ctx-server' } }) })
assert.equal(staleHandshake.status, 409, 'a retired handshake can no longer reach the single contract server')
await server.close()

{
  const checkoutServerRoot = mkdtempSync(join(tmpdir(), 'gotry-booking-v2-http-checkout-after-check-'))
  const checkoutServerLedger = ensureLedger(checkoutServerRoot)
  const checkoutServerRuntime = new BookingCopilotTaskRuntime(checkoutServerLedger, { now: () => '2026-09-01T10:00:00.000Z' })
  let checkoutPlannerCalls = 0
  let markCheckoutPlannerEntered!: () => void
  let releaseCheckoutPlanner!: () => void
  const checkoutPlannerEntered = new Promise<void>((resolve) => { markCheckoutPlannerEntered = resolve })
  const checkoutPlannerRelease = new Promise<void>((resolve) => { releaseCheckoutPlanner = resolve })
  const capability = verifiedCapability('server-offer', 'server-offer:v1', '2026-09-01T10:30:00.000Z')
  const checkoutFixtureAuth = ['checkout', 'after', 'check', 'key'].join('-')
  const checkoutServer = await startBookingCopilotServer({
    apiKey: checkoutFixtureAuth,
    runtime: checkoutServerRuntime,
    principal: { subject: 'bff-checkout-after-check', scope: 'booking:read' },
    ingressBinding: { bind: () => ({ taskId: 'task-http-checkout-after-check', turnId: 'checkout-after-check-turn', contextRef: 'ctx-checkout-after-check', surface: 'tenant', allowedActions: [...BOOKING_FULL_JOURNEY_ACTION_KINDS] }) },
    ingressMode: 'bff-ingress-binding',
    plannerFactory: () => ({
      next: async ({ task: current }) => {
        checkoutPlannerCalls++
        if (checkoutPlannerCalls === 1) {
          return [{ kind: 'operation', action: { ...action('http-check-before-checkout', current.revision), contextRef: current.contextRef, kind: 'offer.check' as const, input: { offerRef: 'server-offer', offerVersionRef: 'server-offer:v1' } } }]
        }
        if (checkoutPlannerCalls === 2) {
          markCheckoutPlannerEntered()
          await checkoutPlannerRelease
        }
        return [{ kind: 'operation', action: { ...action('http-checkout-after-check', current.revision), contextRef: current.contextRef, kind: 'checkout.prepare' as const, input: { offerRef: 'server-offer', offerVersionRef: 'server-offer:v1', verifiedOfferRef: capability.verifiedOfferRef } } }]
      },
    }),
  })
  const checkoutEndpoint = `http://127.0.0.1:${checkoutServer.port}/a2a/booking-copilot/turn`
  const checkoutHeaders = { ...headers, [AUTHORIZATION_HEADER]: ['Bearer', checkoutFixtureAuth].join(' ') }
  const ingressWorkspace = { schemaVersion: 'booking.surface' as const, revision: 0, locale: 'en-US', currency: 'AED', searchDraft: {}, results: { status: 'idle' as const }, visibleHotels: [{ hotelRef: 'server-hotel', name: 'Server Hotel', factRefs: [] }], loadedOffers: [loadedOffer('server-offer', 'server-hotel')], shortlistedOfferRefs: ['server-offer'], selectedOfferRef: 'server-offer' }
  const checkoutIngress = { ...ingress, requestKey: 'checkout-after-check-request-1', taskHandle: 'checkout-after-check-handle', workspace: ingressWorkspace, request: { text: 'check this room and continue to checkout' } }
  const parseEvents = (body: string): BookingSurfaceEvent[] => body.trim().split('\n\n').filter(Boolean).map((frame) => {
    const data = frame.split('\n').find((line) => line.startsWith('data: '))
    assert.ok(data, `SSE frame has data: ${frame}`)
    return JSON.parse(data.slice('data: '.length)) as BookingSurfaceEvent
  })
  const firstCheckoutResponse = await fetch(checkoutEndpoint, { method: 'POST', headers: checkoutHeaders, body: JSON.stringify(checkoutIngress) })
  assert.equal(firstCheckoutResponse.status, 200)
  const firstCheckoutEvents = parseEvents(await firstCheckoutResponse.text())
  const checkEvent = firstCheckoutEvents.find((event): event is Extract<BookingSurfaceEvent, { kind: 'operation' }> => event.kind === 'operation')
  assert.equal(checkEvent?.action.kind, 'offer.check')
  const receiptWorkspace = { ...ingressWorkspace, contextRef: 'ctx-checkout-after-check', surface: 'tenant' as const, revision: 1, capabilities: { surface: 'tenant' as const, allowedActions: [...BOOKING_FULL_JOURNEY_ACTION_KINDS] }, verifiedOffer: capability }
  const checkoutReceiptTurn = {
    schemaVersion: 'booking.surface' as const, kind: 'action.receipt.continuation' as const, taskId: 'task-http-checkout-after-check', workspace: receiptWorkspace,
    receipt: { schemaVersion: 'booking.surface' as const, kind: 'action.receipt' as const, actionId: 'http-check-before-checkout', contextRef: 'ctx-checkout-after-check', status: 'applied' as const, revision: 1, observation: { kind: 'offer.availability' as const, offerRef: 'server-offer', checkedOfferVersionRef: 'server-offer:v1', currentOfferVersionRef: 'server-offer:v1', verifiedOfferRef: capability.verifiedOfferRef, available: true, changedFactRefs: [], gapCodes: [] }, resultContract: { outcome: 'complete' as const, hardCriteriaMet: true, factRefs: [], gapCodes: [], blockers: [], relaxationsApplied: [] } },
  }
  const checkoutContinuationPromise = fetch(checkoutEndpoint, { method: 'POST', headers: checkoutHeaders, body: JSON.stringify(checkoutReceiptTurn) }).then(async (response) => ({ status: response.status, body: await response.text() }))
  await checkoutPlannerEntered
  const substitutedCapability = verifiedCapability('substituted-offer', 'substituted-offer:v1', '2026-09-01T10:30:00.000Z')
  const substitutedWorkspace: BookingWorkspaceSnapshot = { ...receiptWorkspace, visibleHotels: [{ hotelRef: 'substituted-hotel', name: 'Substituted Hotel', factRefs: [] }], loadedOffers: [loadedOffer('substituted-offer', 'substituted-hotel')], shortlistedOfferRefs: ['substituted-offer'], selectedOfferRef: 'substituted-offer', verifiedOffer: substitutedCapability }
  const beforeSubstitutionRows = checkoutServerLedger.countEvents()
  const substitutedTurn = { schemaVersion: 'booking.surface' as const, kind: 'user.turn' as const, taskId: 'task-http-checkout-after-check', turnId: 'http-substitute-after-check', workspace: substitutedWorkspace, request: { text: 'continue with the substituted offer' } }
  const substitutedResponse = await fetch(checkoutEndpoint, { method: 'POST', headers: checkoutHeaders, body: JSON.stringify(substitutedTurn) })
  const substitutedStatus = substitutedResponse.status
  const substitutedBody = await substitutedResponse.json()
  const afterSubstitutionRows = checkoutServerLedger.countEvents()
  releaseCheckoutPlanner()
  assert.equal(substitutedStatus, 409, 'a concurrent bound turn cannot swap the confirmed offer while checkout planning is in flight')
  assert.deepEqual(substitutedBody, { error: { code: 'WORKSPACE_MISMATCH' } })
  assert.equal(afterSubstitutionRows, beforeSubstitutionRows, 'rejected concurrent offer substitution appends no ledger rows')
  const checkoutContinuation = await checkoutContinuationPromise
  assert.equal(checkoutContinuation.status, 200)
  const continuationEvents = parseEvents(checkoutContinuation.body)
  assert.equal(checkoutPlannerCalls, 2, 'confirmed offer.check receipt re-enters the same planner session')
  assert.equal(continuationEvents.some((event) => event.kind === 'terminal'), false, 'confirmed offer.check receipt does not emit a terminal batch')
  const checkoutEvent = continuationEvents.find((event): event is Extract<BookingSurfaceEvent, { kind: 'operation' }> => event.kind === 'operation')
  assert.deepEqual(checkoutEvent?.action.input, { offerRef: 'server-offer', offerVersionRef: 'server-offer:v1', verifiedOfferRef: capability.verifiedOfferRef })
  assert.equal(checkoutServerRuntime.resumeTask('task-http-checkout-after-check')?.pendingAction?.kind, 'checkout.prepare')
  const checkoutHandoffTurn = {
    schemaVersion: 'booking.surface' as const, kind: 'action.receipt.continuation' as const, taskId: 'task-http-checkout-after-check', workspace: { ...receiptWorkspace, revision: 2 },
    receipt: checkoutReceipt('http-checkout-after-check', 'server-offer', 'server-offer:v1', capability.verifiedOfferRef),
  }
  checkoutHandoffTurn.receipt.revision = 2
  checkoutHandoffTurn.receipt.contextRef = 'ctx-checkout-after-check'
  const beforeCheckoutHandoffRows = checkoutServerLedger.countEvents()
  const checkoutHandoffResponse = await fetch(checkoutEndpoint, { method: 'POST', headers: checkoutHeaders, body: JSON.stringify(checkoutHandoffTurn) })
  assert.equal(checkoutHandoffResponse.status, 200)
  const checkoutHandoffBody = await checkoutHandoffResponse.text()
  const checkoutHandoffEvents = parseEvents(checkoutHandoffBody)
  assert.deepEqual(checkoutHandoffEvents.map((event) => event.kind), ['terminal'], 'checkout handoff receipt receives runtime-owned terminal without planner')
  assert.equal(checkoutHandoffEvents[0]?.kind === 'terminal' ? checkoutHandoffEvents[0].terminal.summary : '', 'checkout_handoff_prepared')
  assert.equal(checkoutPlannerCalls, 2, 'checkout handoff terminal does not call the planner again')
  assert.equal(checkoutServerRuntime.resumeTask('task-http-checkout-after-check')?.phase, 'terminal')
  const afterCheckoutHandoffRows = checkoutServerLedger.countEvents()
  const replayCheckoutHandoff = await fetch(checkoutEndpoint, { method: 'POST', headers: checkoutHeaders, body: JSON.stringify(checkoutHandoffTurn) })
  assert.equal(replayCheckoutHandoff.status, 200)
  assert.equal(await replayCheckoutHandoff.text(), checkoutHandoffBody, 'checkout handoff terminal batch replays exactly once')
  assert.equal(checkoutPlannerCalls, 2)
  assert.equal(checkoutServerLedger.countEvents() > beforeCheckoutHandoffRows, true)
  assert.equal(checkoutServerLedger.countEvents(), afterCheckoutHandoffRows, 'checkout handoff replay appends no second terminal')
  await checkoutServer.close(); checkoutServerLedger.close(); rmSync(checkoutServerRoot, { recursive: true, force: true })
}

const defaultBindingRoot = mkdtempSync(join(tmpdir(), 'gotry-booking-v2-default-binding-'))
const defaultBindingLedger = ensureLedger(defaultBindingRoot)
const defaultBindingRuntime = new BookingCopilotTaskRuntime(defaultBindingLedger)
let defaultBindingPlannerCalls = 0
await assert.rejects(startBookingCopilotServer({
  apiKey: 'partial-binding-key',
  runtime: defaultBindingRuntime, plannerFactory: () => ({ next: async () => [] }), principal: { subject: 'partial-only', scope: 'booking:read' },
}), /booking_copilot_ingress_binding_pair_required/)
await assert.rejects(startBookingCopilotServer({
  apiKey: 'partial-principal-key',
  runtime: defaultBindingRuntime, plannerFactory: () => ({ next: async () => [] }), ingressBinding: { bind: () => ({ taskId: 'partial', turnId: 'partial', contextRef: 'partial', surface: 'tenant', allowedActions: [...BOOKING_FULL_JOURNEY_ACTION_KINDS] }) },
}), /booking_copilot_ingress_binding_pair_required/)
const defaultBindingServer = await startBookingCopilotServer({
  apiKey: 'default-binding-key',
  runtime: defaultBindingRuntime,
  plannerFactory: () => ({ next: async () => { defaultBindingPlannerCalls++; return [{ kind: 'terminal', terminal: { status: 'stopped', summary: 'default binding', factRefs: [] } }] } }),
})
const defaultBindingEndpoint = `http://127.0.0.1:${defaultBindingServer.port}/a2a/booking-copilot/turn`
const defaultBindingHeaders = { ...headers, authorization: 'Bearer default-binding-key' }
const defaultBindingBeforeIngress = defaultBindingLedger.countEvents()
const rejectedDefaultIngress = await fetch(defaultBindingEndpoint, { method: 'POST', headers: defaultBindingHeaders, body: JSON.stringify(ingress) })
assert.equal(rejectedDefaultIngress.status, 503, 'bound-turn-only mode rejects browser ingress before the ledger')
assert.deepEqual(await rejectedDefaultIngress.json(), { error: { code: 'trusted_ingress_binding_required', mode: 'bff-bound-turn-only', acceptedTurnKinds: ['user.turn', 'action.receipt.continuation'] } })
assert.equal(defaultBindingLedger.countEvents(), defaultBindingBeforeIngress, 'rejected browser ingress has no ledger side effects')

const boundTurnForSurface = (taskId: string, surface: BookingSurface, allowedActions: BookingReadActionKind[]) => ({
  ...turn(taskId),
  workspace: { ...workspace(), surface, capabilities: { surface, allowedActions } },
})
const invalidBoundTurns = [
  boundTurnForSurface('task-bound-storefront-escalation', 'storefront', ['order.observe']),
  boundTurnForSurface('task-bound-payment-escalation', 'payment_link', ['checkout.prepare']),
  { ...boundTurnForSurface('task-bound-capability-mismatch', 'storefront', ['search.run']), workspace: { ...workspace(), surface: 'storefront', capabilities: { surface: 'tenant', allowedActions: ['search.run'] } } },
  boundTurnForSurface('task-bound-duplicate-capability', 'tenant', ['search.run', 'search.run']),
  boundTurnForSurface('task-bound-unknown-capability', 'tenant', ['book' as BookingReadActionKind]),
]
for (const invalidBoundTurn of invalidBoundTurns) {
  const before = defaultBindingLedger.countEvents()
  const response = await fetch(defaultBindingEndpoint, { method: 'POST', headers: defaultBindingHeaders, body: JSON.stringify(invalidBoundTurn) })
  assert.ok([400, 403].includes(response.status), `${invalidBoundTurn.taskId} is rejected at the schema/authority boundary`)
  assert.equal(defaultBindingLedger.countEvents(), before, `${invalidBoundTurn.taskId} has no ledger side effects`)
}
const invalidBoundContinuation = {
  schemaVersion: 'booking.surface' as const,
  kind: 'action.receipt.continuation' as const,
  taskId: 'task-bound-invalid-continuation',
  workspace: { ...workspace(1), surface: 'storefront' as const, capabilities: { surface: 'storefront' as const, allowedActions: ['order.observe' as BookingReadActionKind] } },
  receipt: {
    schemaVersion: 'booking.surface' as const, kind: 'action.receipt' as const, actionId: 'missing-action', contextRef: 'ctx-v2', status: 'failed' as const, revision: 1,
    observation: { kind: 'gap' as const, code: 'unhandled' as const, factRefs: [] },
    resultContract: { outcome: 'empty' as const, hardCriteriaMet: false, factRefs: [], gapCodes: ['unhandled' as const], blockers: [], relaxationsApplied: [] },
  },
}
const invalidContinuationBefore = defaultBindingLedger.countEvents()
const invalidContinuationResponse = await fetch(defaultBindingEndpoint, { method: 'POST', headers: defaultBindingHeaders, body: JSON.stringify(invalidBoundContinuation) })
assert.equal(invalidContinuationResponse.status, 403, 'receipt continuation cannot change to a surface-disallowed capability')
assert.equal(defaultBindingLedger.countEvents(), invalidContinuationBefore, 'invalid bound continuation has no ledger side effects')
assert.equal(defaultBindingPlannerCalls, 0, 'invalid bound turns do not call the planner')

for (const [surface, allowedActions] of [
  ['tenant', ['search.run']],
  ['customer_portal', ['offers.query']],
  ['storefront', ['search.run']],
  ['payment_link', ['hotel.select']],
] as Array<[BookingSurface, BookingReadActionKind[]]>) {
  const response = await fetch(defaultBindingEndpoint, { method: 'POST', headers: defaultBindingHeaders, body: JSON.stringify(boundTurnForSurface(`task-bound-valid-${surface}`, surface, allowedActions)) })
  assert.equal(response.status, 200, `valid ${surface} bound turn is accepted`)
  assert.match(await response.text(), /event: terminal/)
}
assert.equal(defaultBindingPlannerCalls, 4, 'only valid surface-bound turns call the planner')
await defaultBindingServer.close()
assert.equal(defaultBindingLedger.countEvents() > defaultBindingBeforeIngress, true)
defaultBindingLedger.close(); rmSync(defaultBindingRoot, { recursive: true, force: true })

// HTTP ingress retries after terminal are allowed only for the exact durable
// request batch; a new request key remains fail-closed and cannot append.
const terminalServerRoot = mkdtempSync(join(tmpdir(), 'gotry-booking-v2-http-terminal-replay-'))
const terminalServerLedger = ensureLedger(terminalServerRoot)
const terminalServerRuntime = new BookingCopilotTaskRuntime(terminalServerLedger)
const terminalServer = await startBookingCopilotServer({
  apiKey: 'terminal-server-key',
  runtime: terminalServerRuntime,
  principal: { subject: 'bff-terminal', scope: 'booking:read' },
  ingressBinding: { bind: () => ({ taskId: 'task-http-terminal', turnId: 'http-terminal-turn', contextRef: 'ctx-server', surface: 'tenant', allowedActions: [...BOOKING_FULL_JOURNEY_ACTION_KINDS] }) },
  ingressMode: 'bff-ingress-binding',
  plannerFactory: () => ({ next: async () => [{ kind: 'terminal', terminal: { status: 'stopped', summary: 'terminal replay', factRefs: [] } }] }),
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
  ['storefront', 'task-storefront-escalation', [...BOOKING_READ_ACTION_KINDS], 'storefront'],
  ['payment_link', 'task-payment-escalation', [...BOOKING_READ_ACTION_KINDS], 'payment_link'],
  ['tenant', 'task-surface-mismatch', [...BOOKING_READ_ACTION_KINDS], 'storefront'],
] satisfies Array<readonly [BookingSurface, string, readonly BookingReadActionKind[], BookingSurface]>) {
  const matrixRoot = mkdtempSync(join(tmpdir(), `gotry-booking-v2-${taskId}-`))
  const matrixLedger = ensureLedger(matrixRoot)
  const matrixRuntime = new BookingCopilotTaskRuntime(matrixLedger)
  const matrixServer = await startBookingCopilotServer({
    apiKey: `${taskId}-key`,
    runtime: matrixRuntime,
    principal: { subject: 'bff-matrix', scope: 'booking:read' },
    ingressBinding: { bind: () => ({ taskId, turnId: `${taskId}-turn`, contextRef: 'ctx-server', surface, allowedActions: [...allowedActions] }) },
    ingressMode: 'bff-ingress-binding',
    plannerFactory: () => ({ next: async () => [{ kind: 'terminal', terminal: { status: 'stopped', summary: 'must not plan', factRefs: [] } }] }),
  })
  const matrixResponse = await fetch(`http://127.0.0.1:${matrixServer.port}/a2a/booking-copilot/turn`, { method: 'POST', headers: { ...headers, authorization: `Bearer ${taskId}-key` }, body: JSON.stringify({ ...ingress, requestKey: `${taskId}-request`, surfaceHint: hint }) })
  assert.equal(matrixResponse.status, 502, `${surface} binding escalation/mismatch is rejected before planning`)
  assert.equal(matrixLedger.countEvents(), 0)
  await matrixServer.close(); matrixLedger.close(); rmSync(matrixRoot, { recursive: true, force: true })
}

// Runtime/planner exceptions are always a non-empty typed error SSE event;
// neither an unsupported operation nor raw planner text becomes durable.
const serverLogSecretMarker = 'ISSUE_3580_PROVIDER_SDK_SECRET_MUST_NOT_BE_LOGGED'
for (const [label, plannerFactory, expectedCode] of [
  ['runtime-unsupported-action', () => ({ next: async () => [{ kind: 'operation' as const, action: { ...action('disallowed-http-action'), kind: 'offers.query' as const, input: { hotelRefs: ['hotel-a'], criteria: {} } } }] }), 'UNSUPPORTED_ACTION'],
  ['planner-surface-unsupported', () => ({ next: async () => { throw new Error('planner_surface_action_unsupported: raw internal detail') } }), 'PLANNER_SURFACE_ACTION_UNSUPPORTED'],
  ['planner-provider-secret', () => ({ next: async () => { throw new Error(`provider SDK response ${serverLogSecretMarker}`) } }), 'PLANNER_FAILED'],
] as const) {
  const errorRoot = mkdtempSync(join(tmpdir(), `gotry-booking-v2-${label}-`))
  const errorLedger = ensureLedger(errorRoot)
  const errorRuntime = new BookingCopilotTaskRuntime(errorLedger)
  const errorTaskId = `task-${label}`
  let errorPlannerCalls = 0
  const errorServer = await startBookingCopilotServer({
    apiKey: `${label}-key`,
    runtime: errorRuntime,
    principal: { subject: `bff-${label}`, scope: 'booking:read' },
    ingressBinding: { bind: () => ({ taskId: errorTaskId, turnId: `${errorTaskId}-turn`, contextRef: 'ctx-v2', surface: 'tenant', allowedActions: ['search.run'] }) },
    ingressMode: 'bff-ingress-binding',
    plannerFactory: (_initial: BookingCopilotTaskState) => {
      const session = plannerFactory()
      return { next: async (_input: { turn: any; task: BookingCopilotTaskState }) => { errorPlannerCalls++; return session.next() } }
    },
  })
  const errorTurn = { ...turn(errorTaskId), workspace: { ...workspace(), capabilities: { surface: 'tenant', allowedActions: ['search.run'] } } }
  const serverErrorLogs: string[] = []
  const originalServerConsoleError = console.error
  const errorResponse = await (async () => {
    try {
      console.error = (...args: unknown[]) => { serverErrorLogs.push(args.map((value) => String(value)).join(' ')) }
      return await fetch(`http://127.0.0.1:${errorServer.port}/a2a/booking-copilot/turn`, { method: 'POST', headers: { ...headers, authorization: `Bearer ${label}-key` }, body: JSON.stringify(errorTurn) })
    } finally {
      console.error = originalServerConsoleError
    }
  })()
  assert.equal(errorResponse.status, 200, `${label} keeps the committed SSE status while returning a typed error`)
  const errorBody = await errorResponse.text()
  assert.match(errorBody, /event: error/, `${label} never returns an empty SSE body`)
  assert.match(errorBody, new RegExp(`"code":"${expectedCode}"`), `${label} normalizes to the closed uppercase code`)
  assert.doesNotMatch(errorBody, /raw internal detail/, `${label} does not expose internal error text`)
  assert.equal(serverErrorLogs.some((line) => line.includes(expectedCode)), true, `${label} stderr retains the closed diagnostic code`)
  assert.equal(serverErrorLogs.some((line) => line.includes(serverLogSecretMarker)), false, `${label} stderr omits provider-authored secret text`)
  assert.doesNotMatch(errorBody, /event: operation/, `${label} emits no disallowed operation`)
  const actionRows = errorLedger.db.prepare("SELECT count(*) AS count FROM events WHERE kind = 'booking.copilot.action.issued'").get() as { count: number }
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

// Default composition is BFF-bound-turn-only. Browser ingress remains
// unavailable until the trusted BFF principal/binding seam is supplied.
const boundOnlyRoot = mkdtempSync(join(tmpdir(), 'gotry-booking-bound-only-'))
const boundOnlyLedger = ensureLedger(boundOnlyRoot)
const boundOnlyRuntime = new BookingCopilotTaskRuntime(boundOnlyLedger)
const boundOnlyServer = await startBookingCopilotServer({ apiKey: 'bound-only-key', runtime: boundOnlyRuntime, plannerFactory: () => ({ next: async () => [] }) })
const boundOnlyHealth = await fetch(`http://127.0.0.1:${boundOnlyServer.port}/healthz`, { headers: { authorization: 'Bearer bound-only-key' } })
assert.equal(boundOnlyHealth.status, 200)
assert.deepEqual(await boundOnlyHealth.json(), { schemaVersion: 'booking.surface', schemaSha256: BOOKING_SURFACE_SCHEMA_SHA256, status: 'ready', ingressMode: 'bff-bound-turn-only', acceptedTurnKinds: ['user.turn', 'action.receipt.continuation'] }, 'bound-turn-only health reports the closed turn-kind set')
await boundOnlyServer.close()
boundOnlyLedger.close(); rmSync(boundOnlyRoot, { recursive: true, force: true })
const ingressBindingRoot = mkdtempSync(join(tmpdir(), 'gotry-booking-ingress-binding-'))
const ingressBindingLedger = ensureLedger(ingressBindingRoot)
const ingressBindingRuntime = new BookingCopilotTaskRuntime(ingressBindingLedger)
const ingressBindingServer = await startBookingCopilotServer({
  apiKey: 'ingress-binding-key',
  runtime: ingressBindingRuntime,
  principal: { subject: 'bff-ingress-binding', scope: 'booking:read' },
  ingressBinding: { bind: () => ({ taskId: 'task-ingress-binding', turnId: 'turn-ingress-binding', contextRef: 'ctx-ingress-binding', surface: 'tenant', allowedActions: [...BOOKING_FULL_JOURNEY_ACTION_KINDS] }) },
  ingressMode: 'bff-ingress-binding',
  plannerFactory: () => ({ next: async () => [] }),
})
const ingressBindingHealth = await fetch(`http://127.0.0.1:${ingressBindingServer.port}/healthz`, { headers: { authorization: 'Bearer ingress-binding-key' } })
assert.equal(ingressBindingHealth.status, 200)
assert.deepEqual(await ingressBindingHealth.json(), { schemaVersion: 'booking.surface', schemaSha256: BOOKING_SURFACE_SCHEMA_SHA256, status: 'ready', ingressMode: 'bff-ingress-binding', acceptedTurnKinds: ['user.turn', 'action.receipt.continuation', 'user.turn.ingress'] }, 'ingress-binding health reports the complete trusted ingress mode')
await ingressBindingServer.close()
ingressBindingLedger.close()
rmSync(ingressBindingRoot, { recursive: true, force: true })

runtime['ledger'].close()
crossLedger.close()
awaitingRestart['ledger'].close()
reopened['ledger'].close()
serverRuntime['ledger'].close()
crashLedger.close(); reverseLedger.close()
terminalLedger.close()
forgedSourceRuntime['ledger'].close(); tamperLedger.close()
offerRuntime['ledger'].close()
rmSync(stateRoot, { recursive: true, force: true }); rmSync(serverRoot, { recursive: true, force: true })
rmSync(forgedSourceRoot, { recursive: true, force: true }); rmSync(tamperRoot, { recursive: true, force: true })
rmSync(crashRoot, { recursive: true, force: true }); rmSync(reverseRoot, { recursive: true, force: true }); rmSync(crossRoot, { recursive: true, force: true })
rmSync(terminalRoot, { recursive: true, force: true })
rmSync(offerRoot, { recursive: true, force: true })
console.log('BOOKING COPILOT RUNTIME PROOF: task scope, receipt binding, factRef non-authority, approval authority/one-time, recovery, ingress/SSE session OK')
