/**
 * Real DeepSeek Harness subprocess proof for the embedded booking planner.
 *
 * A local OpenAI-compatible SSE fixture is the model transport; everything
 * between it and BookingPlannerDecisionV1 is the published dsh core, its SDK
 * stdio server, the GoTry plugin, tool execution, session events and adapter.
 */

import assert from 'node:assert/strict'
import { createServer, type ServerResponse } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createDshEmbeddedBookingPlanner,
  DSH_EMBEDDED_BOOKING_TOOL_NAMES,
} from '../src/booking-surface/dsh-planner.ts'
import type { BookingCopilotTaskStateV1 } from '../src/booking-surface/runtime.ts'
import type { BookingWorkspaceSnapshotV1, UserTurnV1 } from '../src/booking-surface/contracts.ts'

const action = {
  schemaVersion: 'booking.surface.v1',
  kind: 'search.run',
  actionId: 'action-real-dsh-1',
  contextRef: 'ctx-real-dsh-1',
  expectedRevision: 0,
  reason: 'Run the authoritative workspace search.',
  factRefs: [],
  input: {},
} as const

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
const modelServer = createServer((req, res) => {
  const parts: Buffer[] = []
  req.on('data', (part: Buffer) => parts.push(part))
  req.on('end', () => {
    const body = JSON.parse(Buffer.concat(parts).toString('utf8'))
    requests.push({ headers: req.headers, body })
    modelCall += 1
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
                arguments: JSON.stringify({ decision: { kind: 'operation', action } }),
              },
            }],
          },
          finish_reason: 'tool_calls',
        }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
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

const workspace: BookingWorkspaceSnapshotV1 = {
  schemaVersion: 'booking.surface.v1',
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
  capabilities: { surface: 'tenant', allowedActions: ['search.run'] },
}
const turn: UserTurnV1 = {
  schemaVersion: 'booking.surface.v1',
  kind: 'user.turn',
  taskId: 'task-real-dsh-1',
  workspace: {
    ...workspace,
    capabilities: { ...workspace.capabilities, allowedActions: [...workspace.capabilities.allowedActions] },
  },
  request: { text: '执行当前酒店搜索' },
}
const task: BookingCopilotTaskStateV1 = {
  schemaVersion: 'booking.surface.v1',
  taskId: 'task-real-dsh-1',
  contextRef: action.contextRef,
  surface: 'tenant',
  revision: 0,
  allowedActions: ['search.run'],
  userTurnCount: 1,
  lastUserTurnDigest: 'digest-only',
  phase: 'planning',
  lastSequence: 0,
}

let planner: Awaited<ReturnType<typeof createDshEmbeddedBookingPlanner>> | undefined
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
  })
  const decisions = await planner.plannerFactory(task).next({ turn, task })
  assert.deepEqual(decisions, [{ kind: 'operation', action }])
  assert.equal(requests.length, 2, 'real dsh loop executes the typed tool then reaches idle')
  const toolNames = requests[0]!.body.tools.map((tool: any) => tool.function.name).sort()
  assert.deepEqual(toolNames, [...DSH_EMBEDDED_BOOKING_TOOL_NAMES].sort(), 'real model request exposes exactly the seven embedded tools')
  assert.ok(!toolNames.some((name: string) => /gotry_book|payment|holder|guest/i.test(name)), 'real model request exposes no booking write or PII tool')
  const executableKeys = requests[0]!.body.tools.flatMap((tool: any) => objectKeys(tool.function.parameters))
  assert.ok(!executableKeys.some((key: string) => /^(book|payment|holder|guest|portalToken|supplierCost)$/i.test(key)), 'tool inputs expose no write or PII field')
  assert.equal(requests[0]!.headers.authorization, 'Bearer fixture-model-key')
  assert.ok(!JSON.stringify(requests).includes('must-not-enter-dsh'), 'BFF and portal credentials never enter the dsh model transport')
} finally {
  await planner?.close()
  await new Promise<void>((resolve, reject) => modelServer.close((error) => error ? reject(error) : resolve()))
  rmSync(stateRoot, { recursive: true, force: true })
}

console.log('BOOKING COPILOT DSH CORE PROOF: real subprocess/sdk/plugin/tool-call/session event/idle OK')
