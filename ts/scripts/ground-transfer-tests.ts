/**
 * Issue #341 focused proof.
 *
 * The product path is exercised through the registered gotry_feasibility_check
 * tool. Map results come from an isolated public-tool-shaped fixture; the
 * separate ToolRuntime case verifies the production nested-dispatch seam.
 * No shared state or live session is used.
 */

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { readFile } from 'node:fs/promises'

import { Context } from '@deepseek-ai/cordis'
import { defineTool, ToolRuntime, type ToolExecutionResult, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import type { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'

import { apply } from '../src/index.ts'
import { parseCandidate } from '../src/model.ts'
import {
  createGroundTransferResolver,
  resolveGroundTransferPayload,
  GROUND_TRANSFER_DEFAULT_MAX_AGE_S,
  GROUND_TRANSFER_STATIC_MODE_MISMATCH,
  GROUND_TRANSFER_STATIC_PRICE_EVIDENCE,
  type GroundTransferProvider,
  type PublicMapDrivingRouteResult,
} from '../capabilities/ground-transfer.ts'

type JsonRecord = Record<string, unknown>

interface RegisteredTool {
  name: string
  execute(args: unknown, execution: unknown): Promise<unknown>
}

interface FeasibilityResult extends JsonRecord {
  ok: boolean
  ground_transfer?: JsonRecord
  verdicts?: JsonRecord[]
}

interface FakeHost {
  root: string
  feasibility: RegisteredTool
}

const FIXED_NOW = new Date('2026-09-10T12:00:00.000Z')
const GROUND_TRANSFER = {
  candidate_id: 'qiandao',
  transfer_index: 0,
  position: 'destination',
  mode: 'driving',
  origin: { longitude: 120.1234, latitude: 30.2345 },
  destination: { longitude: 119.4567, latitude: 29.6789 },
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function asRecord(value: unknown, label: string): JsonRecord {
  assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value), `${label} must be an object`)
  return value as JsonRecord
}

function withoutLatency(value: unknown): unknown {
  const record = asRecord(value, 'tool result')
  const { latency_ms: _latency, ...stable } = record
  return stable
}

function resultOf(value: unknown): FeasibilityResult {
  return asRecord(value, 'feasibility result') as FeasibilityResult
}

function route(durationS: number, provider = 'fixture-osrm'): PublicMapDrivingRouteResult {
  return {
    provider,
    distanceM: 42_500,
    durationS,
    polyline: 'fixture-polyline',
    steps: [],
  }
}

function fakeHost(provider: GroundTransferProvider, clock: () => Date = () => FIXED_NOW): FakeHost {
  const root = mkdtempSync(join(tmpdir(), 'gotry-341-ground-transfer-'))
  const registered: RegisteredTool[] = []
  const ctx = {
    tools: {
      register(tool: unknown) {
        registered.push(tool as RegisteredTool)
      },
    },
    systemPrompt: {
      variable() {},
    },
    get() {
      return undefined
    },
    on() {
      return () => {}
    },
  } as unknown as Context

  apply(ctx, {
    stateRoot: root,
    timeoutMs: 30_000,
    hbcliBin: 'hbcli-not-on-path',
    sessionAccess: 'off',
  }, {
    clock,
    groundTransfer: { provider },
  })

  const feasibility = registered.find(tool => tool.name === 'gotry_feasibility_check')
  assert.ok(feasibility, 'gotry_feasibility_check must be registered')
  return { root, feasibility }
}

async function call(tool: RegisteredTool, payload: JsonRecord): Promise<FeasibilityResult> {
  return resultOf(await tool.execute({ payload: clone(payload) }, null))
}

interface PublicToolExecutionHost {
  execution: ToolExecutionResult
  mapCalls: JsonRecord[]
  dispose: () => Promise<void>
}

async function publicToolExecution(payload: JsonRecord): Promise<PublicToolExecutionHost> {
  const root = mkdtempSync(join(tmpdir(), 'gotry-341-ground-transfer-runtime-'))
  const mapCalls: JsonRecord[] = []
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime, {})
  const unregisterMap = ctx.tools.register(defineTool({
    name: 'map_driving_route',
    description: 'isolated public map tool fixture',
    parameters: {
      origin: { type: 'string', required: true },
      destination: { type: 'string', required: true },
    },
    output: {
      schema: { type: 'json' },
      render: () => [{ type: 'text', text: 'fixture map route' }],
    },
    async execute(args: { origin: string; destination: string }, _execution: ToolRunContext) {
      mapCalls.push({ ...args })
      return route(780, 'fixture-public-map-tool') as unknown as JsonValue
    },
  }))

  apply(ctx, {
    stateRoot: root,
    timeoutMs: 30_000,
    hbcliBin: 'hbcli-not-on-path',
    sessionAccess: 'off',
  }, { clock: () => FIXED_NOW })

  const execution = await ctx.tools.execute({
    callId: 'issue-341-ground-transfer-root' as ToolCallId,
    name: 'gotry_feasibility_check',
    arguments: { payload: clone(payload) },
    signal: new AbortController().signal,
  })
  return {
    execution,
    mapCalls,
    dispose: async () => {
      unregisterMap()
      await ctx.fiber.dispose()
      rmSync(root, { recursive: true, force: true })
    },
  }
}

async function publicToolHost(payload: JsonRecord): Promise<{ result: FeasibilityResult; mapCalls: JsonRecord[]; dispose: () => Promise<void> }> {
  const host = await publicToolExecution(payload)
  if (host.execution.isError) throw new Error(`nested host execution failed: ${host.execution.error.message}`)
  return { result: resultOf(host.execution.value), mapCalls: host.mapCalls, dispose: host.dispose }
}

async function main(): Promise<void> {
  const payload = JSON.parse(await readFile(join(import.meta.dirname, '..', '..', 'data', 'golden_erhai.json'), 'utf8')) as JsonRecord
  const fixtureCalls: JsonRecord[] = []
  let durationS = 900
  const provider: GroundTransferProvider = async request => {
    fixtureCalls.push({ ...request })
    return route(durationS)
  }
  let issueNowMs = FIXED_NOW.getTime()
  const host = fakeHost(provider, () => new Date(issueNowMs))
  try {
    const baseline = await call(host.feasibility, payload)
    const legacyRepeat = await call(host.feasibility, payload)
    assert.deepEqual(withoutLatency(legacyRepeat), withoutLatency(baseline), 'payloads without ground_transfer must keep their legacy result shape')
    assert.equal('ground_transfer' in baseline, false)

    const parsed = payload.candidates as JsonRecord[]
    const parsedCandidates = parsed.map(parseCandidate)
    const originalCandidates = clone(parsedCandidates)
    const directResolver = createGroundTransferResolver({
      provider: async () => route(900),
      clock: () => FIXED_NOW,
    })
    const directPrepared = await resolveGroundTransferPayload(
      GROUND_TRANSFER,
      parsedCandidates,
      directResolver,
    )
    assert.equal(directPrepared.resolution.applied, true)
    assert.equal(directPrepared.candidates[1]!.destTransfers[0]!.minutes, 15)
    assert.equal(directPrepared.candidates[1]!.destTransfers[0]!.priceCny, originalCandidates[1]!.destTransfers[0]!.priceCny)
    assert.equal(directPrepared.candidates[1]!.destTransfers[0]!.mode, originalCandidates[1]!.destTransfers[0]!.mode)
    assert.deepEqual(JSON.parse(JSON.stringify(directPrepared.candidates[0])), JSON.parse(JSON.stringify(originalCandidates[0])), 'unrelated candidates must not be patched')
    assert.deepEqual(directPrepared.candidates[1]!.destTransfers[1], originalCandidates[1]!.destTransfers[1], 'unrelated transfers must not be patched')

    let staticModeProviderCalls = 0
    const staticModeResolver = createGroundTransferResolver({
      provider: async () => {
        staticModeProviderCalls += 1
        return route(900)
      },
      clock: () => FIXED_NOW,
    })
    for (const staticModeRequest of [
      { ...GROUND_TRANSFER, candidate_id: 'qiandao', transfer_index: 1 },
      { ...GROUND_TRANSFER, candidate_id: 'dali', transfer_index: 1 },
    ]) {
      const before = JSON.stringify(parsedCandidates)
      const prepared = await resolveGroundTransferPayload(staticModeRequest, parsedCandidates, staticModeResolver)
      assert.equal(prepared.resolution.applied, false)
      assert.equal(prepared.resolution.provenance, 'static-transfer-pack')
      assert.equal(prepared.resolution.evidenceClass, 'static_transfer_estimate')
      assert.match(prepared.resolution.fallbackReason ?? '', new RegExp(`^${GROUND_TRANSFER_STATIC_MODE_MISMATCH}`))
      assert.equal(JSON.stringify(prepared.candidates), before, 'non-taxi static transfer must stay structurally unchanged')
    }
    assert.equal(staticModeProviderCalls, 0, 'bus and bus_plus_taxi must not call the driving provider')

    const fresh = await call(host.feasibility, { ...payload, ground_transfer: GROUND_TRANSFER })
    assert.equal(fresh.ok, true)
    assert.equal(fixtureCalls.length, 1)
    const freshEvidence = asRecord(fresh.ground_transfer, 'fresh ground_transfer')
    assert.equal(freshEvidence['applied'], true)
    assert.equal(freshEvidence['candidateId'], 'qiandao')
    assert.equal(freshEvidence['transferIndex'], 0)
    assert.equal(freshEvidence['minutes'], 15)
    assert.equal(freshEvidence['staticMinutes'], 25)
    assert.equal(freshEvidence['priceCny'], 30)
    assert.equal(freshEvidence['priceEvidence'], GROUND_TRANSFER_STATIC_PRICE_EVIDENCE)
    assert.equal(freshEvidence['provenance'], 'map_driving_route')
    assert.equal(freshEvidence['asOf'], FIXED_NOW.toISOString())
    assert.equal(freshEvidence['freshness'], 'fresh')
    assert.equal(asRecord(freshEvidence['cache'], 'fresh cache')['status'], 'miss')
    const freshRoute = asRecord(freshEvidence['routeFact'], 'fresh routeFact')
    assert.deepEqual(freshRoute['origin'], GROUND_TRANSFER.origin)
    assert.deepEqual(freshRoute['destination'], GROUND_TRANSFER.destination)
    assert.equal(freshRoute['mode'], 'driving')
    assert.equal(freshRoute['provider'], 'fixture-osrm')
    assert.equal(freshRoute['distanceM'], 42_500)
    assert.equal(freshRoute['durationS'], 900)
    assert.equal(freshRoute['durationMin'], 15)
    assert.equal(freshRoute['evidenceClass'], 'public_map_route_estimate')
    assert.equal(freshRoute['trafficStatus'], 'not-live-route-estimate')
    assert.equal('priceCny' in freshRoute, false, 'route result must not invent a price')
    const freshEvidenceVerdicts = fresh.verdicts ?? []
    assert.equal(freshEvidenceVerdicts.filter(v => 'transfer_evidence' in v).length, 1)
    assert.equal(asRecord(freshEvidenceVerdicts.find(v => v['candidate_id'] === 'qiandao')?.['transfer_evidence'], 'bound transfer evidence')['minutes'], 15)

    const cacheHit = await call(host.feasibility, { ...payload, ground_transfer: GROUND_TRANSFER })
    assert.equal(fixtureCalls.length, 1, 'fresh cache hit must avoid a second provider call')
    const hitEvidence = asRecord(cacheHit.ground_transfer, 'cache-hit ground_transfer')
    assert.equal(hitEvidence['minutes'], 15)
    assert.equal(hitEvidence['freshness'], 'cache_hit')
    assert.equal(asRecord(hitEvidence['cache'], 'cache-hit cache')['status'], 'hit')
    assert.equal(asRecord(hitEvidence['cache'], 'cache-hit cache')['ageS'], 0)

    issueNowMs += (GROUND_TRANSFER_DEFAULT_MAX_AGE_S + 1) * 1_000
    durationS = 1_200
    const stale = await call(host.feasibility, {
      ...payload,
      ground_transfer: GROUND_TRANSFER,
    })
    assert.equal(fixtureCalls.length, 2, 'stale cache entry must requery the provider')
    const staleEvidence = asRecord(stale.ground_transfer, 'stale ground_transfer')
    assert.equal(staleEvidence['minutes'], 20)
    assert.equal(staleEvidence['freshness'], 'fresh')
    assert.equal(asRecord(staleEvidence['cache'], 'stale cache')['status'], 'requery')

    const failingHost = fakeHost(async () => {
      throw new Error('fixture provider unavailable')
    })
    try {
      const fallback = await call(failingHost.feasibility, {
        ...payload,
        ground_transfer: { ...GROUND_TRANSFER, origin: { longitude: 120.5, latitude: 30.5 } },
      })
      const fallbackEvidence = asRecord(fallback.ground_transfer, 'provider fallback ground_transfer')
      assert.equal(fallbackEvidence['applied'], true)
      assert.equal(fallbackEvidence['minutes'], 25)
      assert.equal(fallbackEvidence['priceCny'], 30)
      assert.equal(fallbackEvidence['priceEvidence'], GROUND_TRANSFER_STATIC_PRICE_EVIDENCE)
      assert.equal(fallbackEvidence['provenance'], 'static-transfer-pack')
      assert.equal(fallbackEvidence['asOf'], null)
      assert.equal(fallbackEvidence['evidenceClass'], 'static_transfer_estimate')
      assert.equal(asRecord(fallbackEvidence['cache'], 'provider fallback cache')['status'], 'bypass')
      assert.match(String(fallbackEvidence['fallbackReason']), /provider unavailable/)
    } finally {
      rmSync(failingHost.root, { recursive: true, force: true })
    }

    const missingHost = fakeHost(async () => undefined)
    try {
      const missing = await call(missingHost.feasibility, {
        ...payload,
        ground_transfer: { ...GROUND_TRANSFER, origin: { longitude: 120.6, latitude: 30.6 } },
      })
      const missingEvidence = asRecord(missing.ground_transfer, 'provider-miss ground_transfer')
      assert.equal(missingEvidence['minutes'], 25)
      assert.equal(missingEvidence['priceCny'], 30)
      assert.equal(missingEvidence['provenance'], 'static-transfer-pack')
      assert.match(String(missingEvidence['fallbackReason']), /invalid public result/)
    } finally {
      rmSync(missingHost.root, { recursive: true, force: true })
    }

    const invalidCoordinates = await call(host.feasibility, {
      ...payload,
      ground_transfer: { ...GROUND_TRANSFER, destination: { longitude: 181, latitude: 29 } },
    })
    const invalidEvidence = asRecord(invalidCoordinates.ground_transfer, 'invalid-coordinate ground_transfer')
    assert.equal(invalidEvidence['minutes'], 25)
    assert.equal(invalidEvidence['priceCny'], 30)
    assert.equal(invalidEvidence['provenance'], 'static-transfer-pack')
    assert.match(String(invalidEvidence['fallbackReason']), /invalid_ground_transfer_coordinates/)
    assert.equal(fixtureCalls.length, 2, 'invalid coordinates must not call the provider')

    const unsupportedMode = await call(host.feasibility, {
      ...payload,
      ground_transfer: { ...GROUND_TRANSFER, mode: 'walking' },
    })
    const unsupportedEvidence = asRecord(unsupportedMode.ground_transfer, 'unsupported-mode ground_transfer')
    assert.equal(unsupportedEvidence['minutes'], 25)
    assert.equal(unsupportedEvidence['priceCny'], 30)
    assert.equal(unsupportedEvidence['provenance'], 'static-transfer-pack')
    assert.match(String(unsupportedEvidence['fallbackReason']), /unsupported_ground_transfer_mode:walking/)
    assert.equal(fixtureCalls.length, 2, 'unsupported mode must not call the provider')
    assert.doesNotMatch(JSON.stringify(unsupportedMode), /public transit|rail|transit/i)

    const unknownMode = await call(host.feasibility, {
      ...payload,
      ground_transfer: { ...GROUND_TRANSFER, mode: 'unknown' },
    })
    const unknownEvidence = asRecord(unknownMode.ground_transfer, 'unknown-mode ground_transfer')
    assert.equal(unknownEvidence['minutes'], 25)
    assert.match(String(unknownEvidence['fallbackReason']), /unsupported_ground_transfer_mode:unknown/)
    assert.equal(fixtureCalls.length, 2, 'unknown mode must not call the provider')

    const busTransfer = await call(host.feasibility, {
      ...payload,
      ground_transfer: { ...GROUND_TRANSFER, candidate_id: 'qiandao', transfer_index: 1 },
    })
    const busEvidence = asRecord(busTransfer.ground_transfer, 'bus ground_transfer')
    assert.equal(busEvidence['applied'], false)
    assert.equal(busEvidence['staticMode'], 'bus')
    assert.equal(busEvidence['staticMinutes'], 40)
    assert.equal(busEvidence['priceCny'], 8)
    assert.equal(busEvidence['provenance'], 'static-transfer-pack')
    assert.equal(busEvidence['freshness'], 'not_attempted')
    assert.match(String(busEvidence['fallbackReason']), /^ground_transfer_static_mode_mismatch/)
    assert.equal(fixtureCalls.length, 2, 'bus transfer must not call the provider')
    assert.equal(asRecord(busTransfer.verdicts?.find(v => v['candidate_id'] === 'qiandao')?.['transfer_evidence'], 'bus transfer evidence')['applied'], false)

    const busPlusTaxiTransfer = await call(host.feasibility, {
      ...payload,
      ground_transfer: { ...GROUND_TRANSFER, candidate_id: 'dali', transfer_index: 1 },
    })
    const busPlusTaxiEvidence = asRecord(busPlusTaxiTransfer.ground_transfer, 'bus_plus_taxi ground_transfer')
    assert.equal(busPlusTaxiEvidence['applied'], false)
    assert.equal(busPlusTaxiEvidence['staticMode'], 'bus_plus_taxi')
    assert.equal(busPlusTaxiEvidence['staticMinutes'], 105)
    assert.equal(busPlusTaxiEvidence['priceCny'], 40)
    assert.equal(busPlusTaxiEvidence['provenance'], 'static-transfer-pack')
    assert.match(String(busPlusTaxiEvidence['fallbackReason']), /^ground_transfer_static_mode_mismatch/)
    assert.equal(fixtureCalls.length, 2, 'bus_plus_taxi transfer must not call the provider')

    const bindingMismatch = await call(host.feasibility, {
      ...payload,
      ground_transfer: { ...GROUND_TRANSFER, candidate_id: 'not-a-candidate' },
    })
    const mismatchEvidence = asRecord(bindingMismatch.ground_transfer, 'binding-mismatch ground_transfer')
    assert.equal(mismatchEvidence['applied'], false)
    assert.equal(mismatchEvidence['provenance'], 'none')
    assert.equal(mismatchEvidence['freshness'], 'not_attempted')
    assert.match(String(mismatchEvidence['fallbackReason']), /ground_transfer_binding_mismatch/)
    assert.equal(fixtureCalls.length, 2, 'binding mismatch must not call the provider')

    const transferMismatch = await call(host.feasibility, {
      ...payload,
      ground_transfer: { ...GROUND_TRANSFER, transfer_index: 99 },
    })
    const transferMismatchEvidence = asRecord(transferMismatch.ground_transfer, 'transfer-index-mismatch ground_transfer')
    assert.equal(transferMismatchEvidence['applied'], false)
    assert.match(String(transferMismatchEvidence['fallbackReason']), /ground_transfer_binding_mismatch/)
    assert.equal(fixtureCalls.length, 2, 'transfer binding mismatch must not call the provider')

    const runtimeHost = await publicToolHost({ ...payload, ground_transfer: GROUND_TRANSFER })
    try {
      const runtimeEvidence = asRecord(runtimeHost.result.ground_transfer, 'real ToolRuntime ground_transfer')
      assert.equal(runtimeEvidence['provenance'], 'map_driving_route')
      assert.equal(runtimeEvidence['minutes'], 13)
      assert.equal(runtimeEvidence['asOf'], FIXED_NOW.toISOString())
      assert.equal(runtimeHost.mapCalls.length, 1)
      assert.equal(runtimeHost.mapCalls[0]!['origin'], '120.1234,30.2345')
      assert.equal(runtimeHost.mapCalls[0]!['destination'], '119.4567,29.6789')
      assert.equal('mode' in runtimeHost.mapCalls[0]!, false, 'mode is implied by the public map tool name')
    } finally {
      await runtimeHost.dispose()
    }

    const unknownAgeHost = await publicToolExecution({
      ...payload,
      ground_transfer: { ...GROUND_TRANSFER, max_age_s: 1 },
    })
    try {
      assert.equal(unknownAgeHost.execution.isError, false, 'guarded ToolRuntime schema rejection is returned as a structured tool failure')
      if (!unknownAgeHost.execution.isError) {
        const rejection = asRecord(unknownAgeHost.execution.value, 'unknown max_age_s rejection')
        assert.equal(rejection['ok'], false, 'closed ToolRuntime schema must reject caller TTL')
        assert.match(`${rejection['summary'] ?? ''} ${rejection['evidence'] ?? ''}`, /max_age_s|additional|unknown/i)
      }
    } finally {
      await unknownAgeHost.dispose()
    }

    console.log('issue #341 ground-transfer focused suite: OK')
  } finally {
    rmSync(host.root, { recursive: true, force: true })
  }
}

await main()
