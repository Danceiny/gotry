/**
 * Issue #341 focused proof, Issue #364 direction-binding additions.
 *
 * The product path is exercised through the registered gotry_feasibility_check
 * tool. Map results come from an isolated public-tool-shaped fixture; the
 * separate ToolRuntime case verifies the production nested-dispatch seam.
 * No shared state or live session is used.
 *
 * Each `ground_transfer` request resolves both directions (outbound = origin
 * → destination, return = destination → origin) with isolated cache,
 * freshness, and fallback. A legacy single-pair shape is normalized to
 * outbound + the swapped pair as return.
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
import { evaluateChoice, parseCandidate, parseRequest } from '../src/model.ts'
import { segmentsFromCandidate, solveChoiceSegment } from '../src/unified.ts'
import {
  createGroundTransferResolver,
  resolveGroundTransferPayload,
  GROUND_TRANSFER_DEFAULT_MAX_AGE_S,
  GROUND_TRANSFER_STATIC_MODE_MISMATCH,
  GROUND_TRANSFER_STATIC_PRICE_EVIDENCE,
  type GroundTransferDirectionResolution,
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

function directionOf(value: unknown, label: string): GroundTransferDirectionResolution {
  const record = asRecord(value, label)
  assert.ok(record['direction'] === 'outbound' || record['direction'] === 'return', `${label}.direction must be outbound or return`)
  return record as unknown as GroundTransferDirectionResolution
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
    // Legacy single-pair shape: outbound = origin→destination, return = swapped
    // pair. Both directions resolve to 15 min (route(900) = 15 min).
    assert.equal(directPrepared.resolution.outboundMinutes, 15)
    assert.equal(directPrepared.resolution.returnMinutes, 15)
    assert.equal(directionOf(directPrepared.resolution.outbound, 'outbound')['direction'], 'outbound')
    assert.equal(directionOf(directPrepared.resolution.return, 'return')['direction'], 'return')
    assert.equal(directPrepared.resolution.outbound.staticMinutes, 25)
    assert.equal(directPrepared.resolution.return.staticMinutes, 25)
    const patchedDirect = directPrepared.candidates[1]!.destTransfers[0]!
    assert.equal(patchedDirect.minutes, 25)
    assert.equal(patchedDirect.minutesOut, 15)
    assert.equal(patchedDirect.minutesRet, 15)
    assert.equal(patchedDirect.priceCny, originalCandidates[1]!.destTransfers[0]!.priceCny)
    assert.equal(patchedDirect.mode, originalCandidates[1]!.destTransfers[0]!.mode)
    assert.deepEqual(JSON.parse(JSON.stringify(directPrepared.candidates[0])), JSON.parse(JSON.stringify(originalCandidates[0])), 'unrelated candidates must not be patched')
    assert.deepEqual(directPrepared.candidates[1]!.destTransfers[1], originalCandidates[1]!.destTransfers[1], 'unrelated transfers must not be patched')

    // explicit-mode mismatch: bus / bus_plus_taxi → static fallback, driver never called.
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
      assert.equal(directionOf(prepared.resolution.outbound, 'mismatch.outbound').provenance, 'static-transfer-pack')
      assert.equal(directionOf(prepared.resolution.return, 'mismatch.return').provenance, 'static-transfer-pack')
      assert.equal(JSON.stringify(prepared.candidates), before, 'non-taxi static transfer must stay structurally unchanged')
    }
    assert.equal(staticModeProviderCalls, 0, 'bus and bus_plus_taxi must not call the driving provider')

    const fresh = await call(host.feasibility, { ...payload, ground_transfer: GROUND_TRANSFER })
    assert.equal(fresh.ok, true)
    // Both directions are queried through the same provider with different origin/destination pairs.
    assert.equal(fixtureCalls.length, 2)
    const outboundCall = fixtureCalls[0]!
    const returnCall = fixtureCalls[1]!
    assert.equal(outboundCall['origin'], '120.1234,30.2345')
    assert.equal(outboundCall['destination'], '119.4567,29.6789')
    assert.equal(returnCall['origin'], '119.4567,29.6789')
    assert.equal(returnCall['destination'], '120.1234,30.2345')
    const freshEvidence = asRecord(fresh.ground_transfer, 'fresh ground_transfer')
    assert.equal(freshEvidence['applied'], true)
    assert.equal(freshEvidence['candidateId'], 'qiandao')
    assert.equal(freshEvidence['transferIndex'], 0)
    assert.equal(freshEvidence['outboundMinutes'], 15)
    assert.equal(freshEvidence['returnMinutes'], 15)
    assert.equal(freshEvidence['staticMinutes'], 25)
    assert.equal(freshEvidence['priceCny'], 30)
    assert.equal(freshEvidence['priceEvidence'], GROUND_TRANSFER_STATIC_PRICE_EVIDENCE)
    assert.equal(freshEvidence['provenance'], 'map_driving_route')
    assert.equal(freshEvidence['asOf'], FIXED_NOW.toISOString())
    assert.equal(freshEvidence['freshness'], 'fresh')
    assert.equal(asRecord(freshEvidence['cache'], 'fresh cache')['status'], 'miss')

    const freshOutbound = directionOf(freshEvidence['outbound'], 'fresh.outbound')
    const freshReturn = directionOf(freshEvidence['return'], 'fresh.return')
    assert.equal(freshOutbound.minutes, 15)
    assert.equal(freshOutbound.freshness, 'fresh')
    assert.equal(freshOutbound.provenance, 'map_driving_route')
    assert.equal(asRecord(freshOutbound['cache'], 'fresh.outbound.cache')['status'], 'miss')
    assert.deepEqual(asRecord(freshOutbound['routeFact'], 'fresh.outbound.routeFact')['origin'], GROUND_TRANSFER.origin)
    assert.deepEqual(asRecord(freshOutbound['routeFact'], 'fresh.outbound.routeFact')['destination'], GROUND_TRANSFER.destination)
    assert.equal(asRecord(freshOutbound['routeFact'], 'fresh.outbound.routeFact')['direction'], 'outbound')
    assert.equal(asRecord(freshOutbound['routeFact'], 'fresh.outbound.routeFact')['provider'], 'fixture-osrm')
    assert.equal(asRecord(freshOutbound['routeFact'], 'fresh.outbound.routeFact')['durationMin'], 15)
    assert.equal(asRecord(freshOutbound['routeFact'], 'fresh.outbound.routeFact')['evidenceClass'], 'public_map_route_estimate')
    assert.equal(asRecord(freshOutbound['routeFact'], 'fresh.outbound.routeFact')['trafficStatus'], 'not-live-route-estimate')
    assert.equal('priceCny' in asRecord(freshOutbound['routeFact'], 'fresh.outbound.routeFact'), false, 'route result must not invent a price')

    assert.equal(freshReturn.minutes, 15)
    assert.equal(freshReturn.freshness, 'fresh')
    assert.deepEqual(asRecord(freshReturn['routeFact'], 'fresh.return.routeFact')['origin'], GROUND_TRANSFER.destination)
    assert.deepEqual(asRecord(freshReturn['routeFact'], 'fresh.return.routeFact')['destination'], GROUND_TRANSFER.origin)
    assert.equal(asRecord(freshReturn['routeFact'], 'fresh.return.routeFact')['direction'], 'return')

    const freshEvidenceVerdicts = fresh.verdicts ?? []
    assert.equal(freshEvidenceVerdicts.filter(v => 'transfer_evidence' in v).length, 1)
    const verdictEvidence = asRecord(freshEvidenceVerdicts.find(v => v['candidate_id'] === 'qiandao')?.['transfer_evidence'], 'bound transfer evidence')
    assert.equal(verdictEvidence['outboundMinutes'], 15)
    assert.equal(verdictEvidence['returnMinutes'], 15)

    const cacheHit = await call(host.feasibility, { ...payload, ground_transfer: GROUND_TRANSFER })
    assert.equal(fixtureCalls.length, 2, 'fresh cache hit must avoid a second provider call')
    const hitEvidence = asRecord(cacheHit.ground_transfer, 'cache-hit ground_transfer')
    assert.equal(hitEvidence['outboundMinutes'], 15)
    assert.equal(hitEvidence['returnMinutes'], 15)
    // Full cache hit keeps the legacy aggregate freshness semantics;
    // per-direction freshness is the authoritative per-direction record.
    assert.equal(hitEvidence['freshness'], 'cache_hit')
    assert.equal(asRecord(hitEvidence['cache'], 'cache-hit aggregate cache')['status'], 'hit')
    assert.equal(asRecord(directionOf(hitEvidence['outbound'], 'hit.outbound')['cache'], 'cache-hit outbound cache')['status'], 'hit')
    assert.equal(asRecord(directionOf(hitEvidence['return'], 'hit.return')['cache'], 'cache-hit return cache')['status'], 'hit')
    assert.equal(asRecord(directionOf(hitEvidence['outbound'], 'hit.outbound')['cache'], 'cache-hit outbound cache')['ageS'], 0)
    assert.equal(asRecord(directionOf(hitEvidence['return'], 'hit.return')['cache'], 'cache-hit return cache')['ageS'], 0)
    assert.equal(directionOf(hitEvidence['outbound'], 'hit.outbound')['freshness'], 'cache_hit')
    assert.equal(directionOf(hitEvidence['return'], 'hit.return')['freshness'], 'cache_hit')

    issueNowMs += (GROUND_TRANSFER_DEFAULT_MAX_AGE_S + 1) * 1_000
    durationS = 1_200
    const stale = await call(host.feasibility, {
      ...payload,
      ground_transfer: GROUND_TRANSFER,
    })
    assert.equal(fixtureCalls.length, 4, 'stale cache entries must requery the provider for both directions')
    const staleEvidence = asRecord(stale.ground_transfer, 'stale ground_transfer')
    assert.equal(staleEvidence['outboundMinutes'], 20)
    assert.equal(staleEvidence['returnMinutes'], 20)
    assert.equal(staleEvidence['freshness'], 'fresh')
    assert.equal(asRecord(staleEvidence['cache'], 'stale aggregate cache')['status'], 'requery', 'stale aggregate cache keeps the legacy requery semantics')
    assert.equal(directionOf(staleEvidence['outbound'], 'stale.outbound')['freshness'], 'fresh')
    assert.equal(directionOf(staleEvidence['return'], 'stale.return')['freshness'], 'fresh')
    assert.equal(asRecord(directionOf(staleEvidence['outbound'], 'stale.outbound')['cache'], 'stale.outbound.cache')['status'], 'requery')
    assert.equal(asRecord(directionOf(staleEvidence['return'], 'stale.return')['cache'], 'stale.return.cache')['status'], 'requery')

    const failingHost = fakeHost(async () => {
      throw new Error('fixture provider unavailable')
    })
    try {
      const fallback = await call(failingHost.feasibility, {
        ...payload,
        ground_transfer: { ...GROUND_TRANSFER, origin: { longitude: 120.5, latitude: 30.5 } },
      })
      const fallbackEvidence = asRecord(fallback.ground_transfer, 'provider fallback ground_transfer')
      assert.equal(fallbackEvidence['applied'], false)
      assert.equal(fallbackEvidence['provenance'], 'static-transfer-pack')
      assert.equal(fallbackEvidence['evidenceClass'], 'static_transfer_estimate')
      assert.equal(fallbackEvidence['asOf'], null)
      assert.equal(asRecord(fallbackEvidence['cache'], 'provider fallback cache')['status'], 'bypass')
      assert.match(String(fallbackEvidence['fallbackReason']), /provider unavailable/)
      const fallbackOutbound = directionOf(fallbackEvidence['outbound'], 'fallback.outbound')
      const fallbackReturn = directionOf(fallbackEvidence['return'], 'fallback.return')
      assert.equal(fallbackOutbound.applied, false)
      assert.equal(fallbackOutbound.staticMinutes, 25)
      assert.equal(fallbackReturn.applied, false)
      assert.equal(fallbackReturn.staticMinutes, 25)
      assert.match(String(fallbackOutbound['fallbackReason']), /provider unavailable/)
      assert.match(String(fallbackReturn['fallbackReason']), /provider unavailable/)
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
      assert.equal(missingEvidence['applied'], false)
      assert.equal(missingEvidence['provenance'], 'static-transfer-pack')
      assert.match(String(missingEvidence['fallbackReason']), /invalid public result/)
      const missingOutbound = directionOf(missingEvidence['outbound'], 'missing.outbound')
      const missingReturn = directionOf(missingEvidence['return'], 'missing.return')
      assert.equal(missingOutbound.applied, false)
      assert.equal(missingOutbound.staticMinutes, 25)
      assert.equal(missingReturn.applied, false)
      assert.equal(missingReturn.staticMinutes, 25)
    } finally {
      rmSync(missingHost.root, { recursive: true, force: true })
    }

    const invalidCoordinates = await call(host.feasibility, {
      ...payload,
      ground_transfer: { ...GROUND_TRANSFER, destination: { longitude: 181, latitude: 29 } },
    })
    const invalidEvidence = asRecord(invalidCoordinates.ground_transfer, 'invalid-coordinate ground_transfer')
    assert.equal(invalidEvidence['applied'], false)
    assert.equal(invalidEvidence['provenance'], 'static-transfer-pack')
    assert.match(String(invalidEvidence['fallbackReason']), /invalid_ground_transfer_coordinates/)
    assert.equal(fixtureCalls.length, 4, 'invalid coordinates must not call the provider')

    const unsupportedMode = await call(host.feasibility, {
      ...payload,
      ground_transfer: { ...GROUND_TRANSFER, mode: 'walking' },
    })
    const unsupportedEvidence = asRecord(unsupportedMode.ground_transfer, 'unsupported-mode ground_transfer')
    assert.equal(unsupportedEvidence['applied'], false)
    assert.equal(unsupportedEvidence['provenance'], 'static-transfer-pack')
    assert.match(String(unsupportedEvidence['fallbackReason']), /unsupported_ground_transfer_mode:walking/)
    assert.equal(fixtureCalls.length, 4, 'unsupported mode must not call the provider')
    assert.doesNotMatch(JSON.stringify(unsupportedMode), /public transit|rail|transit/i)

    const unknownMode = await call(host.feasibility, {
      ...payload,
      ground_transfer: { ...GROUND_TRANSFER, mode: 'unknown' },
    })
    const unknownEvidence = asRecord(unknownMode.ground_transfer, 'unknown-mode ground_transfer')
    assert.equal(unknownEvidence['applied'], false)
    assert.match(String(unknownEvidence['fallbackReason']), /unsupported_ground_transfer_mode:unknown/)
    assert.equal(fixtureCalls.length, 4, 'unknown mode must not call the provider')

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
    assert.equal(fixtureCalls.length, 4, 'bus transfer must not call the provider')
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
    assert.equal(fixtureCalls.length, 4, 'bus_plus_taxi transfer must not call the provider')

    const bindingMismatch = await call(host.feasibility, {
      ...payload,
      ground_transfer: { ...GROUND_TRANSFER, candidate_id: 'not-a-candidate' },
    })
    const mismatchEvidence = asRecord(bindingMismatch.ground_transfer, 'binding-mismatch ground_transfer')
    assert.equal(mismatchEvidence['applied'], false)
    assert.equal(mismatchEvidence['provenance'], 'none')
    assert.equal(mismatchEvidence['freshness'], 'not_attempted')
    assert.match(String(mismatchEvidence['fallbackReason']), /ground_transfer_binding_mismatch/)
    assert.equal(fixtureCalls.length, 4, 'binding mismatch must not call the provider')

    const transferMismatch = await call(host.feasibility, {
      ...payload,
      ground_transfer: { ...GROUND_TRANSFER, transfer_index: 99 },
    })
    const transferMismatchEvidence = asRecord(transferMismatch.ground_transfer, 'transfer-index-mismatch ground_transfer')
    assert.equal(transferMismatchEvidence['applied'], false)
    assert.match(String(transferMismatchEvidence['fallbackReason']), /ground_transfer_binding_mismatch/)
    assert.equal(fixtureCalls.length, 4, 'transfer binding mismatch must not call the provider')

    // Real ToolRuntime nested map_driving_route: both directions dispatched,
    // both return 13 min from the same public map fixture.
    const runtimeHost = await publicToolHost({ ...payload, ground_transfer: GROUND_TRANSFER })
    try {
      const runtimeEvidence = asRecord(runtimeHost.result.ground_transfer, 'real ToolRuntime ground_transfer')
      assert.equal(runtimeEvidence['provenance'], 'map_driving_route')
      assert.equal(runtimeEvidence['outboundMinutes'], 13)
      assert.equal(runtimeEvidence['returnMinutes'], 13)
      assert.equal(runtimeEvidence['asOf'], FIXED_NOW.toISOString())
      assert.equal(runtimeHost.mapCalls.length, 2)
      assert.deepEqual(runtimeHost.mapCalls[0], {
        origin: '120.1234,30.2345',
        destination: '119.4567,29.6789',
      })
      assert.deepEqual(runtimeHost.mapCalls[1], {
        origin: '119.4567,29.6789',
        destination: '120.1234,30.2345',
      })
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

    // ─── Issue #364 per-direction binding additions ──────────────────────────

    // taxi-only payload: constrains the solver to the patched transfer so the
    // asymmetric route minutes flow into `evaluateChoice` without being
    // shadowed by a cheaper unpatched sibling transfer.
    const taxiOnlyPayload: JsonRecord = {
      ...payload,
      candidates: (payload.candidates as JsonRecord[]).map((candidate: JsonRecord) => {
        if (candidate['id'] !== 'qiandao') return candidate
        const transfers = candidate['dest_transfers'] as JsonRecord[] | undefined
        return { ...candidate, dest_transfers: [transfers![0]!] }
      }),
    }

    // 1. Asymmetric fake: A→B = 13 min (780s), B→A = 31 min (1860s). The solver
    //    must consume each direction separately and reflect 13 for arrival
    //    and 31 for return through the actual `solveChoiceSegment` path.
    const asymmetricCalls: JsonRecord[] = []
    const asymmetricHost = fakeHost(async request => {
      asymmetricCalls.push({ ...request })
      const isReturn = request.origin === '119.4567,29.6789'
      return route(isReturn ? 1_860 : 780, isReturn ? 'asymmetric-return' : 'asymmetric-outbound')
    })
    try {
      const asymmetric = await call(asymmetricHost.feasibility, { ...taxiOnlyPayload, ground_transfer: GROUND_TRANSFER })
      assert.equal(asymmetric.ok, true)
      assert.equal(asymmetricCalls.length, 2)
      const asymEvidence = asRecord(asymmetric.ground_transfer, 'asymmetric ground_transfer')
      assert.equal(asymEvidence['applied'], true)
      assert.equal(asymEvidence['outboundMinutes'], 13)
      assert.equal(asymEvidence['returnMinutes'], 31)
      const asymVerdict = (asymmetric.verdicts ?? []).find(v => v['candidate_id'] === 'qiandao')!
      const asymTc = asRecord(asymVerdict['true_cost'], 'asymmetric true_cost')
      assert.equal(asymTc['arrive_stay'], '10:00', 'outbound 13 min ⇒ G7315 9:47 + 13 = 10:00')
      assert.equal(asymTc['leave_stay_return'], '17:49', 'return 31 min ⇒ G7316 18:40 − 20 − 31 = 17:49')
      const asymChosen = asRecord(asymVerdict['chosen'], 'asymmetric chosen')
      assert.equal(asymChosen['out_service'], 'G7315')
      assert.equal(asymChosen['ret_service'], 'G7316')
      assert.equal(asymChosen['out_transfer'], 'taxi')
      assert.equal(asymChosen['ret_transfer'], 'taxi')

      // End-to-end through `resolveGroundTransferPayload` → `segmentsFromCandidate`
      // → `solveChoiceSegment` → `evaluateChoice`: the same path the registered
      // tool executes. The arrival/return minutes are read per direction from the
      // patched transfer, so swapping them in the route must not change the verdict.
      const asymCandidates = parsedCandidates.map(candidate => {
        if (candidate.id !== 'qiandao') return candidate
        return {
          ...candidate,
          destTransfers: [{
            ...candidate.destTransfers[0]!,
            minutesOut: 13,
            minutesRet: 31,
          }],
        }
      })
      const asymReq = parseRequest(payload['request'] as Record<string, unknown>)
      const asymSpec = segmentsFromCandidate(asymReq, asymCandidates)
      const asymSolved = solveChoiceSegment(asymSpec, asymReq)
      const asymPathVerdict = (asymSolved['verdicts'] as JsonRecord[]).find(v => v['candidate_id'] === 'qiandao')!
      const asymPathTc = asRecord(asymPathVerdict['true_cost'], 'asymmetric path true_cost')
      assert.equal(asymPathTc['arrive_stay'], '10:00')
      assert.equal(asymPathTc['leave_stay_return'], '17:49')

      // Direct evaluateChoice sanity: with both overrides on the same transfer,
      // arrival uses minutesOut and return uses minutesRet independently.
      const asymTaxi = asymCandidates[1]!.destTransfers[0]!
      const asymCost = evaluateChoice(asymCandidates[1]!, asymReq, {
        outService: asymCandidates[1]!.servicesOut[0]!,
        outTransfer: asymTaxi,
        retService: asymCandidates[1]!.servicesRet[0]!,
        retTransfer: asymTaxi,
        days: asymReq.windowDays,
      })
      assert.equal(asymCost.arriveStayMin, 600, 'outbound 9:47 + minutesOut(13) = 10:00')
      assert.equal(asymCost.departHomeRetMin, 945, 'return G7482 16:36 − 20 − minutesRet(31) = 15:45')

      // Counter-direction sanity: if we swap the overrides, the arrival uses 31
      // and the return uses 13 — proves the binding is genuinely per-direction
      // and not just "use the route minutes for both".
      const swappedTaxi = { ...asymTaxi, minutesOut: 31, minutesRet: 13 }
      const swappedCost = evaluateChoice(asymCandidates[1]!, asymReq, {
        outService: asymCandidates[1]!.servicesOut[0]!,
        outTransfer: swappedTaxi,
        retService: asymCandidates[1]!.servicesRet[0]!,
        retTransfer: swappedTaxi,
        days: asymReq.windowDays,
      })
      assert.equal(swappedCost.arriveStayMin, 618, 'arrival 9:47 + 31 = 10:18')
      assert.equal(swappedCost.departHomeRetMin, 963, 'return 16:36 − 20 − 13 = 16:03 = 963')

      // Direct `evaluateChoice` on the same scenario but with G7316 ret (the
      // service the production solver actually picks) gives the 17:49 figure
      // asserted through the full registered-tool pipeline above.
      const asymCostLateRet = evaluateChoice(asymCandidates[1]!, asymReq, {
        outService: asymCandidates[1]!.servicesOut[0]!,
        outTransfer: asymTaxi,
        retService: asymCandidates[1]!.servicesRet[1]!,
        retTransfer: asymTaxi,
        days: asymReq.windowDays,
      })
      assert.equal(asymCostLateRet.departHomeRetMin, 1069, 'G7316 18:40 − 20 − 31 = 17:49 = 1069 (matches verdict)')
    } finally {
      rmSync(asymmetricHost.root, { recursive: true, force: true })
    }

    // 2. Per-direction cache: A→B and B→A are separate cache entries.
    const isolatedCalls: JsonRecord[] = []
    const isolatedHost = fakeHost(async request => {
      isolatedCalls.push({ ...request })
      return route(720, 'isolated-fixture')
    })
    try {
      await call(isolatedHost.feasibility, { ...payload, ground_transfer: GROUND_TRANSFER })
      assert.equal(isolatedCalls.length, 2)
      const firstOutbound = isolatedCalls[0]
      const firstReturn = isolatedCalls[1]
      assert.deepEqual(firstOutbound, { origin: '120.1234,30.2345', destination: '119.4567,29.6789', mode: 'driving' })
      assert.deepEqual(firstReturn, { origin: '119.4567,29.6789', destination: '120.1234,30.2345', mode: 'driving' })

      // Second call: both directions are cache hits, no new provider call.
      await call(isolatedHost.feasibility, { ...payload, ground_transfer: GROUND_TRANSFER })
      assert.equal(isolatedCalls.length, 2, 'second call must reuse both direction caches independently')

      // Explicit outbound/return shape: cache for those exact coordinate pairs.
      const explicitOutbound = {
        longitude: 121.0,
        latitude: 31.0,
      }
      const explicitReturn = {
        longitude: 122.0,
        latitude: 32.0,
      }
      await call(isolatedHost.feasibility, {
        ...payload,
        ground_transfer: {
          candidate_id: 'qiandao',
          transfer_index: 0,
          position: 'destination',
          mode: 'driving',
          outbound: { origin: explicitOutbound, destination: GROUND_TRANSFER.destination },
          return: { origin: GROUND_TRANSFER.destination, destination: explicitReturn },
        },
      })
      assert.equal(isolatedCalls.length, 4)
      const newOutboundCall = isolatedCalls[2]
      const newReturnCall = isolatedCalls[3]
      assert.deepEqual(newOutboundCall, { origin: '121,31', destination: '119.4567,29.6789', mode: 'driving' })
      assert.deepEqual(newReturnCall, { origin: '119.4567,29.6789', destination: '122,32', mode: 'driving' })
    } finally {
      rmSync(isolatedHost.root, { recursive: true, force: true })
    }

    // 3. One-sided failure: A→B succeeds (13 min), B→A throws. Arrival uses
    //    13 from the live route; return falls back to static minutes (25).
    //    The aggregate provenance reflects the partial route success.
    const oneSidedCalls: JsonRecord[] = []
    const oneSidedHost = fakeHost(async request => {
      oneSidedCalls.push({ ...request })
      if (request.destination === '120.1234,30.2345') {
        throw new Error('return-side provider outage')
      }
      return route(780, 'one-sided-outbound')
    })
    try {
      const oneSided = await call(oneSidedHost.feasibility, { ...taxiOnlyPayload, ground_transfer: GROUND_TRANSFER })
      assert.equal(oneSidedCalls.length, 2)
      const osEvidence = asRecord(oneSided.ground_transfer, 'one-sided ground_transfer')
      assert.equal(osEvidence['applied'], true)
      assert.equal(osEvidence['outboundMinutes'], 13)
      assert.equal(osEvidence['returnMinutes'], undefined, 'failed return direction does not borrow the outbound value')
      assert.equal(osEvidence['provenance'], 'map_driving_route')
      const osOutbound = directionOf(osEvidence['outbound'], 'one-sided.outbound')
      const osReturn = directionOf(osEvidence['return'], 'one-sided.return')
      assert.equal(osOutbound.applied, true)
      assert.equal(osOutbound.minutes, 13)
      assert.equal(osReturn.applied, false)
      assert.equal(osReturn.minutes, undefined)
      assert.equal(osReturn.staticMinutes, 25)
      assert.match(String(osReturn.fallbackReason), /return-side provider outage/)

      const osVerdict = (oneSided.verdicts ?? []).find(v => v['candidate_id'] === 'qiandao')!
      const osTc = asRecord(osVerdict['true_cost'], 'one-sided true_cost')
      assert.equal(osTc['arrive_stay'], '10:00', 'arrival uses the successful outbound 13 min')
      // 18*60+40 − 20 − 25 = 1075 = 17:55 (static minutes win on the failed return).
      assert.equal(osTc['leave_stay_return'], '17:55', 'return falls back to static 25 min ⇒ 18:40 − 20 − 25 = 17:55')
    } finally {
      rmSync(oneSidedHost.root, { recursive: true, force: true })
    }

    // 4. Real ToolRuntime nested map_driving_route through registered
    //    gotry_feasibility_check into actual solveChoiceSegment. Use an
    //    asymmetric map tool that returns 780s outbound and 1860s return.
    const realAsymmetricRoot = mkdtempSync(join(tmpdir(), 'gotry-364-real-asymmetric-'))
    const realMapCalls: JsonRecord[] = []
    const realCtx = new Context()
    await realCtx.plugin(SystemPrompt)
    await realCtx.plugin(ToolRuntime, {})
    realCtx.tools.register(defineTool({
      name: 'map_driving_route',
      description: 'asymmetric real map tool',
      parameters: {
        origin: { type: 'string', required: true },
        destination: { type: 'string', required: true },
      },
      output: {
        schema: { type: 'json' },
        render: () => [{ type: 'text', text: 'asymmetric map route' }],
      },
      async execute(args: { origin: string; destination: string }, _execution: ToolRunContext) {
        realMapCalls.push({ ...args })
        const isReturn = args.origin === '119.4567,29.6789'
        return route(isReturn ? 1_860 : 780, isReturn ? 'real-return' : 'real-outbound') as unknown as JsonValue
      },
    }))
    apply(realCtx, {
      stateRoot: realAsymmetricRoot,
      timeoutMs: 30_000,
      hbcliBin: 'hbcli-not-on-path',
      sessionAccess: 'off',
    }, { clock: () => FIXED_NOW })
    try {
      const realExecution = await realCtx.tools.execute({
        callId: 'issue-364-asymmetric-root' as ToolCallId,
        name: 'gotry_feasibility_check',
        arguments: { payload: clone({ ...taxiOnlyPayload, ground_transfer: GROUND_TRANSFER }) },
        signal: new AbortController().signal,
      })
      assert.equal(realExecution.isError, false, `nested tool execution failed: ${realExecution.isError ? realExecution.error.message : ''}`)
      const realResult = resultOf(realExecution.value)
      const realEvidence = asRecord(realResult.ground_transfer, 'real ToolRuntime asymmetric evidence')
      assert.equal(realEvidence['applied'], true)
      assert.equal(realEvidence['outboundMinutes'], 13)
      assert.equal(realEvidence['returnMinutes'], 31)
      assert.equal(realMapCalls.length, 2)
      const realOutboundCall = realMapCalls[0]!
      const realReturnCall = realMapCalls[1]!
      assert.equal(realOutboundCall['origin'], '120.1234,30.2345')
      assert.equal(realOutboundCall['destination'], '119.4567,29.6789')
      assert.equal(realReturnCall['origin'], '119.4567,29.6789')
      assert.equal(realReturnCall['destination'], '120.1234,30.2345')

      const realVerdict = (realResult.verdicts ?? []).find(v => v['candidate_id'] === 'qiandao')!
      const realTc = asRecord(realVerdict['true_cost'], 'real ToolRuntime asymmetric true_cost')
      assert.equal(realTc['arrive_stay'], '10:00')
      assert.equal(realTc['leave_stay_return'], '17:49', 'real ToolRuntime → real solveChoiceSegment → real evaluateChoice uses minutesRet = 31')

      // Reverse coordinates: prove the solver no longer reuses the outbound
      // value for the return when the route fact is genuinely asymmetric.
      const reverseReq = parseRequest(payload['request'] as Record<string, unknown>)
      const reverseCandidates = (payload.candidates as JsonRecord[]).filter((c: JsonRecord) => c['id'] === 'qiandao').map(parseCandidate)
      reverseCandidates[0]!.destTransfers = [reverseCandidates[0]!.destTransfers[0]!]
      // Force the patched transfer to keep the symmetric minutes field (25) and
      // assign per-direction overrides to mirror the asymmetric fake.
      reverseCandidates[0]!.destTransfers[0]!.minutes = 25
      reverseCandidates[0]!.destTransfers[0]!.minutesOut = 13
      reverseCandidates[0]!.destTransfers[0]!.minutesRet = 31
      const reverseSpec = segmentsFromCandidate(reverseReq, reverseCandidates)
      const reverseSolved = solveChoiceSegment(reverseSpec, reverseReq)
      const reverseVerdict = (reverseSolved['verdicts'] as JsonRecord[]).find(v => v['candidate_id'] === 'qiandao')!
      const reverseTc = asRecord(reverseVerdict['true_cost'], 'reverse-coordinate true_cost')
      assert.equal(reverseTc['arrive_stay'], '10:00')
      assert.equal(reverseTc['leave_stay_return'], '17:49')
    } finally {
      await realCtx.fiber.dispose()
      rmSync(realAsymmetricRoot, { recursive: true, force: true })
    }

    // 5. Backward-compat: legacy payload with no ground_transfer keeps byte-
    //    for-byte behavior; same baseline is reused unchanged.
    const baselineAgain = await call(host.feasibility, payload)
    assert.deepEqual(withoutLatency(baselineAgain), withoutLatency(baseline))

    console.log('issue #341 ground-transfer focused suite: OK')
  } finally {
    rmSync(host.root, { recursive: true, force: true })
  }
}

await main()
