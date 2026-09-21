/** Real SDK initialize / provider-stall proof with a controllable CLI startup gate. */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createDshEmbeddedBookingPlanner, createRealRunPort, PLANNER_BOOT_BUDGET_MS, type DshPlannerRunPort, type DshPlannerTurnMetric } from '../src/booking-surface/dsh-planner.ts'
import type { BookingCopilotTaskState } from '../src/booking-surface/runtime.ts'
import type { BookingCopilotTurn, BookingWorkspaceSnapshot } from '../src/booking-surface/contracts.ts'

const root = mkdtempSync(join(tmpdir(), 'gotry-506-readiness-'))
const priorWarmup = process.env.GOTRY_BOOKING_COPILOT_WARMUP
process.env.GOTRY_BOOKING_COPILOT_WARMUP = '0' // this proof owns exactly one port per case
const actualBin = pathToFileURL(join(dirname(fileURLToPath(import.meta.resolve('@deepseek-ai/dsh/package.json'))), 'lib/bin.js')).href
const requests: string[] = []
const sockets = new Set<import('node:net').Socket>()
const server = createServer((req, res) => {
  let text = ''
  req.on('data', (part: Buffer) => { text += part.toString('utf8') })
  req.on('end', () => {
    requests.push(text)
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.flushHeaders() // the real SDK has a provider connection that never completes
  })
})
server.on('connection', (socket) => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)) })
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
const address = server.address()
assert.ok(address && typeof address !== 'string')
const env = { PATH: process.env.PATH, DEEPSEEK_API_KEY: 'fixture-model-key', DEEPSEEK_BASE_URL: `http://127.0.0.1:${address.port}/v1` }
const workspace: BookingWorkspaceSnapshot = {
  schemaVersion: 'booking.surface', contextRef: 'ctx-506', surface: 'tenant', revision: 0,
  locale: 'en', currency: 'AED', searchDraft: {}, results: { status: 'idle' },
  visibleHotels: [], loadedOffers: [], shortlistedOfferRefs: [],
  capabilities: { surface: 'tenant', allowedActions: ['search.run'] },
}
const task: BookingCopilotTaskState = {
  schemaVersion: 'booking.surface', taskId: 'task-506', contextRef: workspace.contextRef,
  surface: 'tenant', revision: 0, allowedActions: ['search.run'], userTurnCount: 1,
  lastTurnId: 'turn-506', operationCount: 0, phase: 'planning', lastSequence: 0,
  availability: { initialized: true, recoveryStarted: false, availabilityPhase: 'need_offers', activeHotelOrdinal: 0, hotelRefs: [], hotels: {}, attempts: [], queryReservations: [] },
  workspaceSnapshot: workspace,
}
const turn: BookingCopilotTurn = { schemaVersion: 'booking.surface', kind: 'user.turn', taskId: task.taskId, turnId: task.lastTurnId!, workspace, request: { text: 'STALL_PROVIDER_PROOF_506' } }

async function bounded<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(label)), ms) })])
  } finally { clearTimeout(timer) }
}
async function until(check: () => boolean, ms: number, label: string): Promise<void> {
  const limit = Date.now() + ms
  while (!check()) {
    if (Date.now() >= limit) throw new Error(label)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}
function alive(pid: number): boolean { try { process.kill(pid, 0); return true } catch { return false } }
function gate(name: string) {
  const marker = join(root, `${name}-started.json`)
  const release = join(root, `${name}-release`)
  const dshBin = join(root, `${name}-dsh.mjs`)
  writeFileSync(dshBin, `import { existsSync, writeFileSync } from 'node:fs'\nwriteFileSync(${JSON.stringify(marker)}, JSON.stringify({pid:process.pid,workerPid:process.ppid,startupPhase:'before_initialize'}))\nconst deadline=Date.now()+15000\nwhile(!existsSync(${JSON.stringify(release)})){if(Date.now()>deadline)process.exit(73);await new Promise(r=>setTimeout(r,10))}\nconst {runCli}=await import(${JSON.stringify(actualBin)});await runCli()\n`)
  return { marker, release, dshBin, pids: () => JSON.parse(readFileSync(marker, 'utf8')) as { pid: number; workerPid: number; startupPhase: string } }
}
let port: DshPlannerRunPort | undefined
let planner: Awaited<ReturnType<typeof createDshEmbeddedBookingPlanner>> | undefined
let phase = 'initial'
let evidence: Record<string, unknown> = {}
try {
  const ready = gate('ready')
  port = await createRealRunPort({ stateRoot: root, env, dshBin: ready.dshBin, maxTokens: 512 })
  phase = 'awaiting_real_initialize'
  let warmupSettled = false
  const warming = port.warmup!().then(() => { warmupSettled = true })
  void warming.catch(() => undefined) // the bounded await below owns setup failure reporting
  await until(() => existsSync(ready.marker) || warmupSettled, 5_000, 'real dsh never entered startup gate')
  assert.equal(warmupSettled, false, 'warmup must not report ready before the real runtime starts and initializes')
  const readyPids = ready.pids()
  evidence = { ...readyPids, providerRequests: requests.length }
  assert.equal(requests.length, 0, 'initialize never consumes a provider call')
  // A known cold-start delay is outside the provider-stall measurement.
  await new Promise((resolve) => setTimeout(resolve, 1_800))
  assert.equal(warmupSettled, false, 'startup gate still prevents false readiness after 1800ms')
  writeFileSync(ready.release, 'release')
  await bounded(warming, 10_000, 'runtime initialize did not complete')
  assert.equal(requests.length, 0, 'completed warmup still makes zero model calls')
  assert.ok(alive(readyPids.pid) && alive(readyPids.workerPid), 'both owned processes are alive after initialize')
  // Our own boot bill must stay readable next to the provider budget it shares
  // a wire window with, so the port reports what the handshake actually cost.
  const readyBoot = port.bootObservation?.()
  assert.ok(readyBoot, 'the real port must observe its own initialize handshake')
  const bootMsAtFirstTurn = readyBoot.initializeMs
  assert.equal(readyBoot.mode, 'started', 'the first request in a fresh worker performs the handshake')
  assert.ok(bootMsAtFirstTurn > 0, `real initialize cost must be measured: ${JSON.stringify(readyBoot)}`)
  evidence = { ...readyPids, providerRequests: requests.length, boot: readyBoot }
  const readyPort = port
  const readyMetrics: DshPlannerTurnMetric[] = []
  planner = await createDshEmbeddedBookingPlanner({
    runPortFactory: () => readyPort,
    turnTimeoutMs: 1_500,
    onMetric: (metric) => readyMetrics.push(metric),
  })
  phase = 'provider_stall'
  const started = Date.now()
  const resultPromise = planner.plannerFactory(task).next({ turn, task })
  await until(() => requests.length === 1, 3_000, 'initialized real provider was not reached')
  const providerObservedMs = Date.now() - started
  const modelRequest = JSON.parse(requests[0]!) as { tools: Array<{ function: { name: string } }> }
  assert.ok(modelRequest.tools.some((tool) => tool.function.name === 'booking_run_search'), 'real initialized runtime includes the GoTry booking plugin')
  const result = await bounded(resultPromise, 3_000, 'planner did not return a bounded timeout')
  const elapsedMs = Date.now() - started
  assert.equal(result[0]?.kind === 'error' && result[0].error.code, 'PLANNER_PROVIDER_TIMEOUT')
  assert.ok(elapsedMs < 3_000, `provider deadline remains bounded: ${elapsedMs}ms`)
  const stalledTurnMetric = readyMetrics[0]
  assert.ok(stalledTurnMetric, 'the provider-stall turn must report its own metric')
  assert.equal(stalledTurnMetric.bootMode, 'reused', 'a turn on an initialized port reuses the runtime instead of starting one')
  assert.equal(stalledTurnMetric.bootMs, 0, 'a reused runtime contributes no boot time to the turn')
  phase = 'ready_cleanup'
  const cleanupAt = Date.now()
  await bounded(planner.close(), 3_000, 'ready tree cleanup exceeded budget')
  planner = undefined; port = undefined
  assert.ok(!alive(readyPids.pid) && !alive(readyPids.workerPid), 'ready runtime and worker both reaped')
  console.log('DSH READINESS READY:', JSON.stringify({ startupDelayMs: 1800, warmupProviderCalls: 0, providerRequests: requests.length, firstTurnBootMs: bootMsAtFirstTurn, reusedTurnBootMs: stalledTurnMetric.bootMs, providerObservedMs, elapsedMs, cleanupMs: Date.now() - cleanupAt, treeReaped: true }))

  const cold = gate('cold')
  phase = 'cold_start_timeout'
  const coldPort = await createRealRunPort({ stateRoot: root, env, dshBin: cold.dshBin, maxTokens: 512 })
  port = coldPort
  planner = await createDshEmbeddedBookingPlanner({ runPortFactory: () => coldPort, turnTimeoutMs: 1_500 })
  const coldAt = Date.now()
  const coldResultPromise = planner.plannerFactory(task).next({ turn, task })
  await until(() => existsSync(cold.marker), 3_000, 'cold real runtime never entered startup gate')
  const coldPids = cold.pids()
  evidence = { ...coldPids, providerRequests: requests.length }
  const coldResult = await bounded(coldResultPromise, 3_000, 'cold-start timeout did not settle')
  const coldElapsedMs = Date.now() - coldAt
  // The handshake never completed, so no provider call happened: the failure is
  // ours to own and is typed as a local boot timeout, not a provider stall.
  assert.equal(coldResult[0]?.kind === 'error' && coldResult[0].error.code, 'PLANNER_BOOT_TIMEOUT')
  assert.equal(requests.length, 1, 'cold blocked startup reaches no provider')
  await bounded(planner.close(), 3_000, 'cold tree cleanup exceeded budget')
  planner = undefined; port = undefined
  assert.ok(!alive(coldPids.pid) && !alive(coldPids.workerPid), 'cold runtime and worker both reaped')
  console.log('DSH READINESS COLD:', JSON.stringify({ providerRequests: 0, elapsedMs: coldElapsedMs, code: 'PLANNER_BOOT_TIMEOUT', treeReaped: true }))

  // The local boot budget must govern its own phase. With a model-stall budget
  // wider than the boot budget, only the explicit initialize deadline can
  // settle this turn inside the asserted window; the SDK's 10s fallback or the
  // 13.3s stall budget would both land later and fail the bound below.
  phase = 'boot_budget_bound'
  const budgetGate = gate('boot-budget')
  port = await createRealRunPort({ stateRoot: root, env, dshBin: budgetGate.dshBin, maxTokens: 512 })
  planner = await createDshEmbeddedBookingPlanner({ runPortFactory: () => port!, turnTimeoutMs: 20_000 })
  const budgetAt = Date.now()
  const budgetResultPromise = planner.plannerFactory(task).next({ turn, task })
  await until(() => existsSync(budgetGate.marker), 3_000, 'boot-budget runtime never entered startup gate')
  const budgetPids = budgetGate.pids()
  const budgetResult = await bounded(budgetResultPromise, 15_000, 'boot budget did not settle the turn')
  const budgetElapsedMs = Date.now() - budgetAt
  assert.equal(budgetResult[0]?.kind === 'error' && budgetResult[0].error.code, 'PLANNER_BOOT_TIMEOUT')
  assert.ok(budgetElapsedMs >= PLANNER_BOOT_BUDGET_MS, `the boot budget must be consumed before it fires (${budgetElapsedMs}ms)`)
  assert.ok(budgetElapsedMs < PLANNER_BOOT_BUDGET_MS + 6_000, `the local boot budget, not the 13.3s stall budget, must settle this turn (${budgetElapsedMs}ms)`)
  assert.equal(requests.length, 1, 'a blocked handshake makes no provider request')
  await bounded(planner.close(), 3_000, 'boot-budget tree cleanup exceeded budget')
  planner = undefined; port = undefined
  assert.ok(!alive(budgetPids.pid) && !alive(budgetPids.workerPid), 'boot-budget runtime and worker both reaped')
  console.log('DSH READINESS BOOT BUDGET:', JSON.stringify({ budgetMs: PLANNER_BOOT_BUDGET_MS, elapsedMs: budgetElapsedMs, code: 'PLANNER_BOOT_TIMEOUT', providerRequests: 0, treeReaped: true }))

  phase = 'initialize_failure'
  const failedMarker = join(root, 'failed-start.json')
  const failedBin = join(root, 'failed-dsh.mjs')
  writeFileSync(failedBin, `import { writeFileSync } from 'node:fs'\nwriteFileSync(${JSON.stringify(failedMarker)}, JSON.stringify({pid:process.pid,workerPid:process.ppid,exitCode:23,signal:null}))\nprocess.stderr.write('PRIVATE_FIXTURE_DIAGNOSTIC');process.exit(23)\n`)
  port = await createRealRunPort({ stateRoot: root, env, dshBin: failedBin, maxTokens: 512 })
  await assert.rejects(bounded(port.warmup!(), 5_000, 'failed initialize did not settle'), { message: 'HARNESS_START_FAILED' })
  const failed = JSON.parse(readFileSync(failedMarker, 'utf8')) as { pid: number; workerPid: number; exitCode: number; signal: null }
  assert.equal(failed.exitCode, 23)
  assert.equal(failed.signal, null)
  assert.equal(requests.length, 1, 'failed initialize makes no provider calls')
  await bounded(port.close(), 3_000, 'failed-start cleanup exceeded budget')
  port = undefined
  assert.ok(!alive(failed.pid) && !alive(failed.workerPid), 'failed runtime and worker both reaped')
  console.log('DSH READINESS FAILURE CLASSIFICATION:', JSON.stringify({ exitCode: failed.exitCode, signal: failed.signal, error: 'HARNESS_START_FAILED', rawStderrExposed: false, providerRequests: 0, treeReaped: true }))

  // Opt-in distribution run: boot fresh runtimes back to back so the local
  // initialize budget can be set from measured percentiles instead of a guess.
  // Each sample is a new worker plus a new dsh home, so the page cache is the
  // only warm input; the numbers are observations, not a service guarantee.
  const bootSampleCount = Number(process.env.GOTRY_BOOT_SAMPLES ?? 0)
  if (Number.isSafeInteger(bootSampleCount) && bootSampleCount > 0) {
    phase = 'boot_sampling'
    const samples: number[] = []
    for (let index = 1; index <= bootSampleCount; index += 1) {
      const samplePort = await createRealRunPort({ stateRoot: root, env, maxTokens: 512 })
      try {
        await bounded(samplePort.warmup!(), 30_000, `boot sample ${index} initialize did not complete`)
        const observation = samplePort.bootObservation?.()
        assert.ok(observation, `boot sample ${index} must observe its initialize handshake`)
        assert.equal(observation.mode, 'started', `boot sample ${index} boots a fresh worker`)
        samples.push(observation.initializeMs)
      } finally {
        await bounded(samplePort.close(), 10_000, `boot sample ${index} cleanup exceeded budget`)
      }
    }
    const sorted = [...samples].sort((left, right) => left - right)
    const percentile = (fraction: number): number => sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))]!
    console.log('DSH BOOT SAMPLES:', JSON.stringify({ count: sorted.length, minMs: sorted[0], p50Ms: percentile(0.5), p95Ms: percentile(0.95), maxMs: sorted.at(-1) }))
  }
} catch (error) {
  console.error('DSH READINESS FAILURE:', JSON.stringify({ phase, ...evidence, providerRequests: requests.length, error: error instanceof Error ? error.message : 'unknown' }))
  throw error
} finally {
  const cleanup = await Promise.allSettled([planner?.close(), port?.close()])
  for (const socket of sockets) socket.destroy()
  await new Promise<void>((resolve) => server.close(() => resolve()))
  rmSync(root, { recursive: true, force: true })
  if (priorWarmup === undefined) delete process.env.GOTRY_BOOKING_COPILOT_WARMUP
  else process.env.GOTRY_BOOKING_COPILOT_WARMUP = priorWarmup
  const failedCleanup = cleanup.find((result) => result.status === 'rejected')
  if (failedCleanup?.status === 'rejected') throw failedCleanup.reason
}
console.log('BOOKING COPILOT DSH READINESS PROOF: real initialize, provider stall, cold timeout and process cleanup OK')
