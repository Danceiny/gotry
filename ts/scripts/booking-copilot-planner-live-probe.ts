/**
 * Live planner probe: boots the real dsh runtime against the real LLM gateway
 * and one booking task turn, to verify the per-kind tool registration works
 * with the currently routed model (not only the DeepSeek default).
 *
 * Usage: npx tsx scripts/booking-copilot-planner-live-probe.ts
 *   Requires DEEPSEEK_API_KEY (gateway token) and DEEPSEEK_BASE_URL.
 */

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BookingCopilotTurn, BookingWorkspaceSnapshot } from '../src/booking-surface/contracts.ts'
import type { BookingCopilotTaskState } from '../src/booking-surface/runtime.ts'
import { createDshEmbeddedBookingPlanner, type DshPlannerTurnMetric } from '../src/booking-surface/dsh-planner.ts'

const apiKey = process.env.DEEPSEEK_API_KEY
const baseUrl = process.env.DEEPSEEK_BASE_URL ?? 'http://173.208.218.132:3000/v1'
const model = process.env.DEEPSEEK_MODEL ?? 'deepseek-flash'
if (!apiKey) throw new Error('DEEPSEEK_API_KEY required')

const contextRef = 'ctx-live-probe-1'
const workspace: BookingWorkspaceSnapshot = {
  schemaVersion: 'booking.surface',
  contextRef,
  surface: 'tenant',
  revision: 0,
  locale: 'zh-CN',
  currency: 'CNY',
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
  taskId: 'task-live-probe-1',
  turnId: 'live-probe-turn-1',
  workspace,
  request: { text: '明天入住北京的酒店，两晚，四星级，帮我找最便宜的' },
}
const availability = { initialized: true, recoveryStarted: false, availabilityPhase: 'need_offers' as const, activeHotelOrdinal: 0, hotelRefs: [], hotels: {}, attempts: [], queryReservations: [] }
const task: BookingCopilotTaskState = {
  schemaVersion: 'booking.surface',
  taskId: 'task-live-probe-1',
  contextRef,
  surface: 'tenant',
  revision: 0,
  allowedActions: ['search.patch', 'search.run'],
  userTurnCount: 1,
  lastTurnId: 'live-probe-turn-1',
  operationCount: 0,
  phase: 'planning',
  lastSequence: 0,
  availability,
  workspaceSnapshot: workspace,
}

const metrics: DshPlannerTurnMetric[] = []
const stateRoot = mkdtempSync(join(tmpdir(), 'gotry-planner-live-probe-'))
let planner: Awaited<ReturnType<typeof createDshEmbeddedBookingPlanner>> | undefined
try {
  const startedAt = Date.now()
  planner = await createDshEmbeddedBookingPlanner({
    stateRoot,
    env: {
      PATH: process.env.PATH ?? '',
      DEEPSEEK_API_KEY: apiKey,
      DEEPSEEK_BASE_URL: baseUrl,
      DEEPSEEK_MODEL: model,
    },
    // Match the UAT deployment deadline (planner-model-plane.yaml turnTimeoutMs).
    turnTimeoutMs: 45_000,
    onMetric: (metric) => metrics.push(metric),
  })
  const decisions = await planner.plannerFactory(task).next({ turn, task })
  const elapsedMs = Date.now() - startedAt
  console.log('=== elapsedMs:', elapsedMs)
  console.log('=== metric:', JSON.stringify(metrics[0]))
  assert.ok(decisions.length >= 1, 'planner produced a decision')
  const first = decisions[0]
  if (first?.kind === 'operation') {
    console.log('=== operation kind:', first.action.kind)
    console.log('=== action input:', JSON.stringify(first.action.input).slice(0, 400))
    assert.equal(first.action.kind, 'search.patch', 'fresh search turn must produce search.patch (runtime compiles search.run itself)')
  } else {
    console.log('=== decision kind:', first?.kind, JSON.stringify(first).slice(0, 300))
    throw new Error(`unexpected decision kind: ${first?.kind}`)
  }
  console.log('LIVE PLANNER PROBE OK')
} finally {
  await planner?.close()
  rmSync(stateRoot, { recursive: true, force: true })
}
