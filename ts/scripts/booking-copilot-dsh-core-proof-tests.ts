/**
 * Real DeepSeek Harness subprocess proof for the embedded booking planner.
 *
 * A local OpenAI-compatible SSE fixture is the model transport; everything
 * between it and BookingPlannerDecision is the published dsh core, its SDK
 * stdio server, the GoTry plugin, tool execution, session events and adapter.
 */

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createServer, type ServerResponse } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createDshEmbeddedBookingPlanner,
  createRealRunPort,
  resolveRealRunPortConfig,
  DSH_EMBEDDED_BOOKING_TOOL_NAMES,
  type DshPlannerTurnMetric,
  type DshPlannerRunPort,
} from '../src/booking-surface/dsh-planner.ts'
import { bookingDigest, type BookingActionCheckpoint, type BookingCopilotTaskState } from '../src/booking-surface/runtime.ts'
import type { BookingCopilotTurn, BookingReadAction, BookingWorkspaceSnapshot } from '../src/booking-surface/contracts.ts'

const action = {
  schemaVersion: 'booking.surface',
  kind: 'search.run',
  actionId: 'action-real-dsh-1',
  contextRef: 'ctx-real-dsh-1',
  expectedRevision: 0,
  reason: 'Run the authoritative workspace search.',
  factRefs: [],
  input: {},
} as const

function completedCheckpoint(completed: BookingReadAction, sourceTurnId: string): BookingActionCheckpoint {
  const base: Omit<BookingActionCheckpoint, 'actionDigest'> = {
    actionId: completed.actionId,
    kind: completed.kind,
    contextRef: completed.contextRef,
    expectedRevision: completed.expectedRevision,
    factRefs: [...completed.factRefs],
    input: structuredClone(completed.input),
    reasonDigest: bookingDigest(completed.reason),
    inputDigest: bookingDigest(completed.input),
    eventId: `operation-${completed.actionId}`,
    sequence: 1,
    emittedAt: '2026-08-30T12:00:00.000Z',
    sourceTurnId,
  }
  return { ...base, actionDigest: bookingDigest(base) }
}

function sse(res: ServerResponse, chunks: unknown[]): void {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
  })
  for (const chunk of chunks) res.write(`data: ${JSON.stringify(chunk)}\n\n`)
  res.end('data: [DONE]\n\n')
}

function objectKeys(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(objectKeys)
  if (typeof value !== 'object' || value === null) return []
  return Object.entries(value).flatMap(([key, child]) => [key, ...objectKeys(child)])
}

const requests: Array<{ headers: Record<string, string | string[] | undefined>; body: any }> = []
let modelCall = 0
let continuationServed = false
let observeStalledRequest!: () => void
const stalledRequestObserved = new Promise<void>((resolve) => { observeStalledRequest = resolve })
const modelServer = createServer((req, res) => {
  const parts: Buffer[] = []
  req.on('data', (part: Buffer) => parts.push(part))
  req.on('end', () => {
    const body = JSON.parse(Buffer.concat(parts).toString('utf8'))
    requests.push({ headers: req.headers, body })
    modelCall += 1
    if (JSON.stringify(body).includes('STALL_PROVIDER_PROOF')) {
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache' })
      observeStalledRequest()
      return
    }
    // Script by request content, not call order: the prose-only retry budget
    // issues additional runs whose scripted response must stay prose, not the
    // continuation terminal.
    if (!continuationServed && JSON.stringify(body).includes('action.receipt.continuation')) {
      continuationServed = true
      sse(res, [{
        id: 'chatcmpl-booking-continuation', object: 'chat.completion.chunk', created: 0, model: 'deepseek-v4-flash',
        choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'call-booking-continuation', type: 'function', function: { name: 'booking_search_hotels', arguments: JSON.stringify({ kind: 'terminal' }) } }] }, finish_reason: 'tool_calls' }],
      }])
      return
    }
    if (modelCall === 1) {
      sse(res, [{
        id: 'chatcmpl-booking-1',
        object: 'chat.completion.chunk',
        created: 0,
        model: 'deepseek-v4-flash',
        choices: [{
          index: 0,
          delta: {
            role: 'assistant',
            tool_calls: [{
              index: 0,
              id: 'call-booking-1',
              type: 'function',
              function: {
                name: 'booking_search_hotels',
                // The first probabilistic miss omits the mandatory semantic
                // goal. The model-facing schema must reject this before the
                // parent process ever sees a superficially valid action.
                arguments: JSON.stringify({ kind: 'search.patch', input: { patch: { destination: { query: 'Dubai' } } } }),
              },
            }],
          },
          finish_reason: 'tool_calls',
        }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      }])
      return
    }
    if (modelCall === 2) {
      sse(res, [{
        id: 'chatcmpl-booking-repair',
        object: 'chat.completion.chunk',
        created: 0,
        model: 'deepseek-v4-flash',
        choices: [{
          index: 0,
          delta: {
            role: 'assistant',
            tool_calls: [{
              index: 0,
              id: 'call-booking-repair',
              type: 'function',
              function: {
                name: 'booking_search_hotels',
                // This repairs the required intent but still violates the
                // full canonical SearchCriteriaPatch.minProperties rule that
                // the provider-compatible advertised dialect cannot express.
                arguments: JSON.stringify({ kind: 'search.patch', input: { patch: {} }, intent: { target: 'search.results' } }),
              },
            }],
          },
          finish_reason: 'tool_calls',
        }],
      }])
      return
    }
    if (modelCall === 3) {
      sse(res, [{
        id: 'chatcmpl-booking-repair-canonical',
        object: 'chat.completion.chunk',
        created: 0,
        model: 'deepseek-v4-flash',
        choices: [{
          index: 0,
          delta: {
            role: 'assistant',
            tool_calls: [{
              index: 0,
              id: 'call-booking-repair-canonical',
              type: 'function',
              function: {
                name: 'booking_run_search',
                arguments: JSON.stringify({ kind: 'search.run', input: {}, intent: { target: 'search.results' } }),
              },
            }],
          },
          finish_reason: 'tool_calls',
        }],
      }])
      return
    }
    sse(res, [{
      id: 'chatcmpl-booking-2',
      object: 'chat.completion.chunk',
      created: 0,
      model: 'deepseek-v4-flash',
      choices: [{ index: 0, delta: { role: 'assistant', content: 'Typed decision emitted.' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 20, completion_tokens: 4, total_tokens: 24 },
    }])
  })
})

await new Promise<void>((resolve, reject) => {
  modelServer.once('error', reject)
  modelServer.listen(0, '127.0.0.1', () => resolve())
})
const address = modelServer.address()
assert.ok(typeof address === 'object' && address)
const stateRoot = mkdtempSync(join(tmpdir(), 'gotry-booking-dsh-core-'))

const workspace: BookingWorkspaceSnapshot = {
  schemaVersion: 'booking.surface',
  contextRef: action.contextRef,
  surface: 'tenant',
  revision: 0,
  locale: 'zh-CN',
  currency: 'AED',
  searchDraft: {},
  results: { status: 'idle' },
  visibleHotels: [],
  loadedOffers: [],
  shortlistedOfferRefs: [],
  capabilities: { surface: 'tenant', allowedActions: ['search.patch', 'search.run'] },
}
const turn: BookingCopilotTurn = {
  schemaVersion: 'booking.surface',
  kind: 'user.turn',
  taskId: 'task-real-dsh-1',
  turnId: 'real-dsh-turn-1',
  workspace,
  request: { text: '执行当前酒店搜索' },
}
const availability = { initialized: true, recoveryStarted: false, availabilityPhase: 'need_offers' as const, activeHotelOrdinal: 0, hotelRefs: [], hotels: {}, attempts: [], queryReservations: [] }
const task: BookingCopilotTaskState = {
  schemaVersion: 'booking.surface',
  taskId: 'task-real-dsh-1',
  contextRef: action.contextRef,
  surface: 'tenant',
  revision: 0,
  allowedActions: ['search.patch', 'search.run'],
  userTurnCount: 1,
  lastTurnId: 'real-dsh-turn-1',
  operationCount: 0,
  phase: 'planning',
  lastSequence: 0,
  availability,
  workspaceSnapshot: workspace,
}

/**
 * Returns the direct dsh child pids, or null when the host forbids process
 * enumeration (for example hardened sandbox policies that block `ps`).
 * The liveness assertions degrade to a logged skip instead of failing the
 * whole proof on a machine that cannot run `ps`.
 */
function directDshChildPids(): Set<number> | null {
  try {
    const rows = execFileSync('ps', ['-axo', 'pid=,ppid=,command='], { encoding: 'utf8' })
    return new Set(rows.split('\n').flatMap((line) => {
      const match = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line)
      if (!match || Number(match[2]) !== process.pid || /\bps\s+-axo\b/.test(match[3]!)) return []
      return [Number(match[1])]
    }))
  } catch (error) {
    if ((error as { code?: string }).code === 'EPERM') {
      console.log('[core-proof] host forbids `ps`; skipping child-pid liveness assertions (teardown budget still enforced)')
      return null
    }
    throw error
  }
}

function processExists(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch { return false }
}

let planner: Awaited<ReturnType<typeof createDshEmbeddedBookingPlanner>> | undefined
let stalledPlanner: Awaited<ReturnType<typeof createDshEmbeddedBookingPlanner>> | undefined
let stalledPort: DshPlannerRunPort | undefined
const plannerMetrics: DshPlannerTurnMetric[] = []

// Planner route resolution: a deployment that forgot DEEPSEEK_MODEL must not
// look like one that set it. The known default route is explicit and reported
// as `default`, an operator-selected model is reported as `env`/`option`, and a
// non-default provider has to name its model instead of inheriting a vendor one.
{
  const baseEnv = { PATH: process.env.PATH, DEEPSEEK_API_KEY: 'fixture-model-key' }
  const defaultRoute = resolveRealRunPortConfig({ env: baseEnv })
  assert.equal(defaultRoute.model, 'deepseek-v4-flash', 'missing DEEPSEEK_MODEL resolves to the known default route')
  assert.equal(defaultRoute.modelSource, 'default', 'the known default route reports modelSource=default')
  assert.equal(defaultRoute.reasoningEffort, 'off', 'the known default route disables long reasoning')
  assert.equal(defaultRoute.maxTokens, 4_096, 'the known default route keeps the 4k budget')
  const envRoute = resolveRealRunPortConfig({ env: { ...baseEnv, DEEPSEEK_MODEL: 'gateway-selected-model', DEEPSEEK_MAX_TOKENS: '16384' } })
  assert.equal(envRoute.model, 'gateway-selected-model', 'DEEPSEEK_MODEL selects the route')
  assert.equal(envRoute.modelSource, 'env', 'an operator-selected model reports modelSource=env')
  assert.equal(envRoute.reasoningEffort, undefined, 'a custom route keeps its provider reasoning default')
  assert.equal(envRoute.maxTokens, 16_384, 'DEEPSEEK_MAX_TOKENS is honored')
  const optionRoute = resolveRealRunPortConfig({ env: baseEnv, model: 'option-model' })
  assert.equal(optionRoute.model, 'option-model', 'an explicit option selects the route')
  assert.equal(optionRoute.modelSource, 'option', 'an explicit option reports modelSource=option')
  assert.throws(
    () => resolveRealRunPortConfig({ env: baseEnv, provider: 'other-provider' }),
    /booking_planner_model_required_for_nondefault_provider/,
    'a non-default provider must name its model instead of inheriting one',
  )
  assert.throws(
    () => resolveRealRunPortConfig({ env: { PATH: process.env.PATH } }),
    /booking_planner_model_key_required/,
    'a missing planner key still fails closed',
  )
}

try {
  planner = await createDshEmbeddedBookingPlanner({
    stateRoot,
    env: {
      PATH: process.env.PATH,
      DEEPSEEK_API_KEY: 'fixture-model-key',
      DEEPSEEK_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
      GOTRY_BOOKING_COPILOT_API_KEY: 'must-not-enter-dsh',
      HOTELBYTE_TOKEN: 'must-not-enter-dsh',
    },
    maxTokens: 512,
    onMetric: (metric) => plannerMetrics.push(metric),
  })
  const session = planner.plannerFactory(task)
  const decisions = await session.next({ turn, task })
  assert.equal(decisions.length, 1)
  assert.equal(decisions[0]?.kind, 'operation')
  if (decisions[0]?.kind !== 'operation') throw new Error('real dsh did not materialize a booking operation')
  assert.equal(decisions[0].action.kind, 'search.run')
  assert.deepEqual(decisions[0].action.input, {})
  assert.match(decisions[0].action.actionId, /^planner-[a-f0-9]{24}$/)
  assert.notEqual(decisions[0].action.actionId, action.actionId)
  assert.equal(requests.length, 3, 'two in-run schema repairs conclude without a redundant post-tool model request')
  assert.deepEqual(plannerMetrics[0], {
    outcome: 'operation',
    decisionSource: 'model',
    elapsedMs: plannerMetrics[0]?.elapsedMs,
    harnessRunCount: 1,
    modelStepCount: 3,
    schemaRejectedCallCount: 2,
    firstPassValid: false,
    schemaRepairedValid: true,
    proseNudgeRecovered: false,
    repairedValid: true,
    actionKind: 'search.run',
  }, 'safe planner metric distinguishes same-turn repair from first-pass validity')
  assert.ok(Number.isSafeInteger(plannerMetrics[0]?.elapsedMs) && plannerMetrics[0]!.elapsedMs >= 0)
  const firstSystemMessage = (requests[0]!.body.messages as Array<{ role?: string; content?: unknown }>).find((message) => message?.role === 'system')
  assert.ok(firstSystemMessage, 'first model request carries a system message produced by dsh system-prompt')
  const firstSystemContent = typeof firstSystemMessage.content === 'string' ? firstSystemMessage.content : JSON.stringify(firstSystemMessage.content)
  assert.ok(firstSystemContent.includes("You are GoTry's embedded booking planner"), 'first SYSTEM message carries the GoTry personaPrefix (not the generic-default fallback)')
  assert.ok(firstSystemContent.includes('Shape-only example'), 'first SYSTEM message marks the envelope example as shape-only')
  assert.ok(firstSystemContent.includes('{"kind":"search.patch","input":{"patch":'), 'first SYSTEM message carries the shallow semantic proposal example')
  assert.ok(firstSystemContent.includes('"intent":{"target":"search.results"}'), 'first SYSTEM message demonstrates the mandatory semantic goal')
  for (const runtimeField of ['actionId', 'contextRef', 'expectedRevision', 'sourceFactRef', 'factRefs']) {
    assert.ok(!JSON.stringify(requests[0]!.body.tools).includes(`"${runtimeField}"`), `model-facing tools omit runtime-owned ${runtimeField}`)
  }
  assert.equal(requests[0]!.body.model, requests[1]!.body.model, 'required-intent repair stays in one model session')
  assert.equal(requests[1]!.body.model, requests[2]!.body.model, 'canonical semantic repair stays in the same model session')
  const requiredIntentRepairMessages = JSON.stringify(requests[1]!.body.messages)
  assert.match(requiredIntentRepairMessages, /required property 'intent'|must have required property.*intent/, 'first repair identifies the missing semantic intent')
  assert.ok(requiredIntentRepairMessages.includes('call-booking-1'), 'first repair references the rejected call id')
  const canonicalRepairMessages = JSON.stringify(requests[2]!.body.messages)
  assert.match(canonicalRepairMessages, /invalid arguments: decision_schema_violation/, 'second repair contains the execute-time canonical ToolArgsError')
  assert.match(canonicalRepairMessages, /fewer than 1 properties/, 'second repair carries the precise canonical constraint that failed')
  assert.ok(canonicalRepairMessages.includes('call-booking-repair'), 'second repair references the canonical-schema rejected call id')
  const toolNames = requests[0]!.body.tools.map((tool: any) => tool.function.name).sort()
  assert.deepEqual(toolNames, [...DSH_EMBEDDED_BOOKING_TOOL_NAMES].sort(), 'real model request exposes exactly the embedded tool set')
  assert.ok(!toolNames.some((name: string) => /gotry_book|payment|holder|guest/i.test(name)), 'real model request exposes no booking write or PII tool')
  assert.equal(requests[0]!.body.model, 'deepseek-v4-flash', 'the default planner model matches the sdk-minimal catalog')
  assert.deepEqual(requests[0]!.body.thinking, { type: 'disabled' }, 'known default route disables long reasoning for constrained criteria extraction')
  const executableKeys = requests[0]!.body.tools.flatMap((tool: any) => objectKeys(tool.function.parameters))
  assert.ok(!executableKeys.some((key: string) => /^(book|payment|holder|guest|portalToken|supplierCost)$/i.test(key)), 'tool inputs expose no write or PII field')
  assert.equal(requests[0]!.headers.authorization, 'Bearer fixture-model-key')
  assert.ok(!JSON.stringify(requests).includes('must-not-enter-dsh'), 'BFF and portal credentials never enter the dsh model transport')
  const proseDecisions = await session.next({ turn, task })
  assert.equal(proseDecisions[0]?.kind, 'error', 'assistant prose without a tool call never becomes a decision')
  const continuation: BookingCopilotTurn = {
    schemaVersion: 'booking.surface' as const, kind: 'action.receipt.continuation' as const, taskId: task.taskId, workspace,
    receipt: { schemaVersion: 'booking.surface' as const, kind: 'action.receipt' as const, actionId: decisions[0].action.actionId, contextRef: workspace.contextRef, status: 'applied' as const, revision: 1,
      observation: { kind: 'search.state' as const, resultCount: 1 }, resultContract: { outcome: 'complete' as const, hardCriteriaMet: true, factRefs: [], gapCodes: [], blockers: [], relaxationsApplied: [] } },
  }
  const continuationWorkspace = { ...workspace, revision: 1, results: { status: 'ready' as const, resultCount: 1 } }
  const boundContinuation = { ...continuation, workspace: continuationWorkspace }
  const continuationDecisions = await session.next({ turn: boundContinuation, task: { ...task, revision: 1, workspaceSnapshot: continuationWorkspace, lastCompletedAction: completedCheckpoint(decisions[0].action, task.lastTurnId!), lastReceipt: continuation.kind === 'action.receipt.continuation' ? continuation.receipt : undefined } })
  assert.deepEqual(continuationDecisions, [{ kind: 'terminal', terminal: { status: 'completed', summary: 'search_results_ready', factRefs: [] } }], 'real dsh materializes terminal status and summary from the authoritative receipt')

  // Real SDK/subprocess timeout proof: the user-visible decision deadline is
  // independent from child teardown, and handle shutdown reaps the actual dsh
  // process instead of merely incrementing a fake close counter.
  const childrenBefore = directDshChildPids()
  const stalledTask: BookingCopilotTaskState = {
    ...task,
    taskId: 'task-real-dsh-stalled',
    contextRef: 'ctx-real-dsh-stalled',
    lastTurnId: 'real-dsh-stalled-turn',
    workspaceSnapshot: { ...workspace, contextRef: 'ctx-real-dsh-stalled' },
  }
  const stalledTurn: BookingCopilotTurn = {
    schemaVersion: 'booking.surface',
    kind: 'user.turn',
    taskId: stalledTask.taskId,
    turnId: stalledTask.lastTurnId!,
    workspace: stalledTask.workspaceSnapshot!,
    request: { text: 'STALL_PROVIDER_PROOF' },
  }
  // This case measures a provider stall, after the SAME task-owned port has
  // completed real SDK initialize. Cold-start timeout is covered separately
  // by booking-copilot-dsh-readiness-proof.ts without relaxing this deadline.
  const priorWarmup = process.env.GOTRY_BOOKING_COPILOT_WARMUP
  process.env.GOTRY_BOOKING_COPILOT_WARMUP = '0'
  try {
    stalledPort = await createRealRunPort({
      stateRoot,
      env: {
        PATH: process.env.PATH,
        DEEPSEEK_API_KEY: 'fixture-model-key',
        DEEPSEEK_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
      },
      maxTokens: 512,
    })
  } finally {
    if (priorWarmup === undefined) delete process.env.GOTRY_BOOKING_COPILOT_WARMUP
    else process.env.GOTRY_BOOKING_COPILOT_WARMUP = priorWarmup
  }
  await stalledPort.warmup!()
  const readyStalledPort = stalledPort
  stalledPlanner = await createDshEmbeddedBookingPlanner({
    runPortFactory: () => readyStalledPort,
    turnTimeoutMs: 1_500,
  })
  const stalledStartedAt = Date.now()
  const stalledDecisionPromise = stalledPlanner.plannerFactory(stalledTask).next({ turn: stalledTurn, task: stalledTask })
  await Promise.race([
    stalledRequestObserved,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('real stalled provider was not reached')), 5_000)),
  ])
  const stalledChildren = childrenBefore === null ? [] : [...directDshChildPids()!].filter((pid) => !childrenBefore.has(pid))
  if (childrenBefore !== null) {
    assert.ok(stalledChildren.length >= 1, 'real timeout proof observes the task-owned dsh child before the deadline')
  }
  const stalledDecisions = await stalledDecisionPromise
  const stalledResponseMs = Date.now() - stalledStartedAt
  assert.equal(stalledDecisions[0]?.kind, 'error')
  assert.equal(stalledDecisions[0]?.kind === 'error' ? stalledDecisions[0].error.code : '', 'PLANNER_PROVIDER_TIMEOUT')
  assert.ok(stalledResponseMs < 3_000, `real stalled provider returns the typed deadline without awaiting teardown (${stalledResponseMs}ms)`)
  const cleanupStartedAt = Date.now()
  await stalledPlanner.close()
  stalledPlanner = undefined
  assert.ok(Date.now() - cleanupStartedAt < 3_000, 'real stalled dsh cleanup stays inside the per-turn teardown budget')
  if (childrenBefore !== null) {
    assert.ok(stalledChildren.every((pid) => !processExists(pid)), 'real stalled dsh child is reaped after planner shutdown')
  }
} finally {
  await stalledPlanner?.close()
  await stalledPort?.close()
  await planner?.close()
  await new Promise<void>((resolve, reject) => modelServer.close((error) => error ? reject(error) : resolve()))
  rmSync(stateRoot, { recursive: true, force: true })
}

console.log('BOOKING COPILOT DSH CORE PROOF: real subprocess/sdk/plugin/tool-call/concluded-turn/session event/idle OK')
