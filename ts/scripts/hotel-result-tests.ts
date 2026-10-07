/** Hotel retrieval must distinguish supplier/transport failures from an observed empty list.
 * Isolated state and fixture CLIs only; no user profile, provider, or browser is accessed.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { apply } from '../src/index.ts'
import { __resetEffectBreakersForTest, makeProductionInterpreter } from '../capabilities/effect.ts'
import { callHbcliJson, searchHotels } from '../capabilities/hbcli.ts'
import { sessionHotelSearch, __resetRateLimiterForTest } from '../capabilities/session-search.ts'
import { buildHotelEntryUrl } from '../capabilities/session/adapters/ctrip-hotel.ts'
import { __setSessionBridgeForTest, createSessionBridge, EXTENSION_ORIGIN, type SessionJobHandle, type ExtensionJobResult } from '../capabilities/session/extension-bridge.ts'

const root = mkdtempSync(join(tmpdir(), 'gotry-hotel-result-'))
let failed = 0
let passed = 0
async function check(label: string, fn: () => Promise<void>): Promise<void> {
  try { await fn(); passed++; console.log(`ok - ${label}`) }
  catch (e) { failed++; console.error(`FAIL - ${label}: ${(e as Error).message}`) }
}
function fixture(name: string, text: string): string {
  const path = join(root, name)
  writeFileSync(path, `#!${process.execPath}\nprocess.stdout.write(${JSON.stringify(text)});\n`, { mode: 0o700 })
  return path
}
const query = { destination: '长春', checkIn: '2026-12-05', checkOut: '2026-12-08', adults: 2 }
const unavailable = fixture('no-suppliers', '{"code":300010002,"msg":"no available suppliers configured, please contact API seller manager"}')
try {
  await check('Harbin hotel entry preserves the exact dates and occupancy', async () => {
    const r = buildHotelEntryUrl({ to: '哈尔滨', checkIn: '2026-12-09', checkOut: '2026-12-11', adults: 2 })
    assert.equal(r.ok, true)
    assert.equal(r.url, 'https://hotels.ctrip.com/hotels/list?city=5&checkin=2026-12-09&checkout=2026-12-11&adult=2')
  })
  for (const claimed of [false, true]) {
    await check(`login precheck timeout identifies ${claimed ? 'claimed' : 'queued'} phase`, async () => {
      const created = await createSessionBridge({ ports: [0] })
      assert.equal(created.ok, true)
      if (!created.ok) return
      const bridge = created.bridge
      try {
        await fetch(`http://127.0.0.1:${bridge.port}/health`, { headers: { origin: EXTENSION_ORIGIN } })
        const pending = bridge.submit({ kind: 'cookie-names', site: 'ctrip-hotel' }, { timeoutMs: 100, extensionWaitMs: 1000 })
        if (claimed) {
          const poll = await fetch(`http://127.0.0.1:${bridge.port}/jobs`, {
            method: 'POST', headers: { origin: EXTENSION_ORIGIN, 'content-type': 'application/json' },
            body: JSON.stringify({ capabilities: ['ctrip-hotel'] }),
          })
          assert.equal((await poll.json() as { job: { kind: string } }).job.kind, 'cookie-names')
        }
        const result = await pending
        assert.equal(result.ok, false)
        const failure = result as { stage?: string; jobKind?: string; summary: string }
        assert.equal(failure.stage, claimed ? 'claimed' : 'queued')
        assert.equal(failure.jobKind, 'cookie-names')
        assert.match(failure.summary, /登录态检查/)
        assert.doesNotMatch(failure.summary, /标签页无嗅探/)
      } finally { await bridge.close() }
    })
  }
  await check('failed FlyAI flights cannot open the hotel circuit', async () => {
    let hotelCalls = 0
    const interpret = makeProductionInterpreter({ breakers: new Map(), handlers: {
      FLYAI_SEARCH: async (params: unknown) => {
        const kind = (params as { kind: string }).kind
        if (kind === 'hotel') { hotelCalls++; return { ok: true, via: 'flyai', verdict: 'hit', hotels: [{ name: 'Fixture Hotel', price: 680 }] } }
        return { ok: false, via: 'flyai-error', verdict: 'error', retryable: false, upstreamHealth: 'unhealthy' }
      },
    } })
    for (let i = 0; i < 3; i++) await interpret({ effect: 'FLYAI_SEARCH', params: { kind: 'flight' } })
    const blockedFlight = await interpret({ effect: 'FLYAI_SEARCH', params: { kind: 'flight' } })
    assert.equal(blockedFlight.trace.declined, 'circuit-open')
    const hotel = await interpret({ effect: 'FLYAI_SEARCH', params: { kind: 'hotel', destName: '长春', checkInDate: query.checkIn, checkOutDate: query.checkOut } })
    assert.equal(hotel.trace.declined, undefined)
    assert.equal((hotel.result as { verdict?: string } | null)?.verdict, 'hit')
    assert.equal(hotelCalls, 1)
    assert.equal((await interpret({ effect: 'FLYAI_SEARCH', params: { kind: 'flight' } })).trace.declined, 'circuit-open')
  })
  await check('exit 0 business error is not a realtime success', async () => {
    const r = await callHbcliJson(['search', 'hotel-list', '--json'], { hbcliBin: unavailable })
    assert.equal(r.exitCode, 0)
    assert.equal(r.via, 'hbcli-error')
    assert.match(r.error ?? '', /300010002/)
    assert.match(r.evidence, /@error@/)
  })
  await check('supplier configuration error never says realtime zero inventory', async () => {
    const r = await searchHotels(query, { hbcliBin: unavailable })
    assert.equal(r.via, 'hbcli-error')
    assert.match(r.summary, /300010002/)
    assert.doesNotMatch(r.summary, /实时 0 家/)
    assert.equal(r.hotels ?? null, null)
  })
  for (const [name, body] of [['garbage', 'not JSON'], ['missing-list', '{}'], ['bad-list', '{"list":{}}']] as const) {
    await check(`${name} is an invalid observation, not empty inventory`, async () => {
      const r = await searchHotels(query, { hbcliBin: fixture(name, body) })
      assert.equal(r.via, 'hbcli-error')
      assert.doesNotMatch(r.summary, /实时 0 家/)
    })
  }
  await check('a recognized empty list remains a successful zero result', async () => {
    const r = await searchHotels(query, { hbcliBin: fixture('empty', '{"list":[],"basic":{"sessionId":"fixture-session"}}') })
    assert.equal(r.via, 'hbcli-realtime')
    assert.match(r.summary, /实时 0 家/)
  })
  await check('registered hotel tool exposes failure and preserves error evidence', async () => {
    __resetEffectBreakersForTest()
    const tools: Array<{ name: string; execute: (a: unknown, e: unknown) => Promise<unknown>; presentResult?: (a: unknown, v: unknown) => unknown }> = []
    const ctx = { tools: { register: (t: typeof tools[number]) => tools.push(t) }, systemPrompt: { variable: () => () => '' }, on: () => () => {} } as unknown as Context
    apply(ctx, { stateRoot: root, timeoutMs: 1000, hbcliBin: unavailable, sessionAccess: 'off', benchmarkEnvironmentConfigPath: '' })
    const tool = tools.find(t => t.name === 'gotry_hotel_search')!
    const r = await tool.execute(query, {}) as { ok: boolean; verdict: string; evidence: string; summary: string }
    assert.equal(r.ok, false)
    assert.equal(r.verdict, 'error')
    assert.match(r.evidence, /hbcli@error@/)
    assert.doesNotMatch(r.evidence, /静态包/)
    assert.doesNotMatch(JSON.stringify(tool.presentResult?.(query, r)), /无结果/)
  })

  // Use the actual session collector; replace only its external browser transport.
  for (const [label, result, verdict] of [
    ['sniff timeout', { ok: false, timeout: true, title: '酒店列表' }, 'error'],
    ['invalid JSON', { ok: true, body: 'not JSON', title: '酒店列表' }, 'error'],
    ['unrecognized JSON', { ok: true, body: '{"message":"upstream failed"}', title: '酒店列表' }, 'error'],
    ['failed empty envelope', { ok: true, body: '{"code":500,"data":{"hotelList":[]}}', title: '酒店列表' }, 'error'],
    ['failed Ctrip status', { ok: true, body: '{"ResponseStatus":{"Ack":"Failure"},"data":{"hotelList":[]}}', title: '酒店列表' }, 'error'],
    ['invalid nonempty list', { ok: true, body: '{"data":{"hotelList":[{"unexpected":true}],"hotelMatchInfos":[]}}', title: '酒店列表' }, 'error'],
    ['explicit empty list', { ok: true, body: '{"data":{"hotelList":[]}}', title: '酒店列表' }, 'miss'],
    ['priced hotel', { ok: true, body: '{"data":{"hotelList":[{"hotelId":123,"hotelName":"Fixture Hotel","price":680}]}}', title: '酒店列表' }, 'hit'],
    ['page challenge', { ok: false, timeout: true, challenge: true, title: '酒店列表' }, 'challenged'],
  ] as const) {
    await check(`Ctrip ${label} is classified without inventing empty inventory`, async () => {
      __resetRateLimiterForTest()
      const bridge = {
        port: 0, extensionConnected: () => true, close: async () => {},
        submit: async (job: { kind: string }) => ({ ok: true as const, result: job.kind === 'cookie-names' ? { ok: true, names: ['cticket'] } : result as ExtensionJobResult }),
      } satisfies SessionJobHandle
      __setSessionBridgeForTest(bridge)
      const r = await sessionHotelSearch({ to: '长春', cityId: 158, checkIn: query.checkIn, checkOut: query.checkOut })
      assert.equal(r.verdict, verdict)
      assert.equal(r.ok, verdict === 'hit' || verdict === 'miss')
      if (verdict === 'error' || verdict === 'challenged') assert.equal(r.hotels, undefined)
      if (verdict === 'hit') assert.equal(r.hotels?.[0]?.price, 680)
    })
  }
} finally {
  __setSessionBridgeForTest(null)
  __resetRateLimiterForTest()
  __resetEffectBreakersForTest()
  rmSync(root, { recursive: true, force: true })
}
console.log(`hotel result tests: ${passed} passed, ${failed} failed`)
if (failed) process.exitCode = 1
