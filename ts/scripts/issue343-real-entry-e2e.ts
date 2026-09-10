/**
 * Issue #343 real-entry precedence proof.
 *
 * This stays offline: the dsh adapter's fetch calls are deterministic fixture
 * responses and the mock adapter uses the same shared merge helper. The
 * runTurn case exercises extractFacts -> extractSpec -> parse -> merge -> solve
 * -> render without touching shared user state.
 */

import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createOpenAICompatLlm } from '../src/dsh-llm.ts'
import { createMockLlm } from '../src/mock-llm.ts'
import { runTurn, type SolvePort } from '../src/loop.ts'
import { parseFlightPackToSpec, solveUnified } from '../src/unified.ts'
import { mergeProfileWorkWindow, WorkWindowPrecedenceError } from '../src/flight-pack-adapter.ts'
import { FLIGHT_PACK_VERSION } from '../src/flight-pack-contract.ts'
import type { ScheduledWorkWindowProfile, TripState, WorkWindowProfile } from '../src/contracts.ts'

const schedule: ScheduledWorkWindowProfile = {
  startMin: 600,
  endMin: 1140,
  workdays: [0, 1, 2, 3, 4],
  evidence: '用户原话:我的工作时间是洛杉矶当地 10:00 到 19:00',
}

const v2Pack = {
  version: 2,
  legs: [{
    id: 'l1', hub: 'NRT', date: '2026-07-04',
    iana_dep_zone: 'Asia/Tokyo', iana_arr_zone: 'Asia/Tokyo',
    buffer_min: 0, origin_transfer_min: 0, dest_transfer_min: 0,
    services: [{ id: 's1', dep: '06:30', arr: '09:00', price_cny: 100,
      dep_local_date: '2026-07-04', arr_local_date: '2026-07-04' }],
  }],
  meta: { work_window: { home_zone: 'America/Los_Angeles', start: '10:00', end: '19:00', workdays: [0, 1, 2, 3, 4] } },
}

function initialState(): TripState {
  return { calendar: { year: 2026, assertedWeekdays: {} }, profile: {}, gates: [], wishes: [] }
}

function assertPrecedence(): void {
  const parsed = parseFlightPackToSpec(v2Pack)
  assert.equal(parsed[FLIGHT_PACK_VERSION], 2)
  assert.equal(JSON.stringify(parsed).includes('flightPackVersion'), false, 'internal version must not enter JSON')

  const numericProfile = { ...schedule, homeTzOffsetMin: 999 }
  const merged = mergeProfileWorkWindow(parsed, numericProfile)
  assert.equal(merged.workWindow?.homeZone, 'America/Los_Angeles')
  assert.equal(merged.workWindow?.startMin, 600)
  assert.equal(merged.workWindow?.endMin, 1140)

  const preserved = mergeProfileWorkWindow(parsed, undefined)
  assert.deepEqual(preserved.workWindow, parsed.workWindow, 'v2 pack window survives omitted profile')

  const vacation = mergeProfileWorkWindow(parsed, { vacation: true })
  assert.equal(vacation.workWindow, undefined, 'explicit vacation clears v2 work window')

  const withoutPackWindow = parseFlightPackToSpec({ ...v2Pack, meta: {} })
  assert.throws(
    () => mergeProfileWorkWindow(withoutPackWindow, schedule),
    (e: unknown) => e instanceof WorkWindowPrecedenceError && e.code === 'v2_profile_requires_pack_home_zone',
  )
  const invalidZone = { ...parsed, workWindow: { ...parsed.workWindow!, homeZone: 'Foo/Bar' } }
  assert.throws(
    () => mergeProfileWorkWindow(invalidZone, schedule),
    (e: unknown) => e instanceof WorkWindowPrecedenceError && e.code === 'v2_profile_requires_pack_home_zone',
  )

  const v1 = parseFlightPackToSpec({
    version: 1,
    legs: [{ id: 'l1', date: '2026-07-04', hub: 'NRT', buffer_min: 0, origin_transfer_min: 0,
      dest_transfer_min: 0, tz_offset_min: 0, services: [{ id: 's1', dep: '09:00', arr: '12:00', price_cny: 100 }] }],
    meta: { work_window: { home_tz_offset_min: 480, start_min: 540, end_min: 1140, workdays: [0, 1, 2, 3, 4] } },
  })
  assert.equal(v1[FLIGHT_PACK_VERSION], 1)
  const v1Merged = mergeProfileWorkWindow(v1, { ...schedule, homeTzOffsetMin: 240 })
  assert.equal(v1Merged.workWindow?.homeTzOffsetMin, 240)
  assert.equal(mergeProfileWorkWindow(v1, undefined).workWindow, undefined)
  assert.equal(mergeProfileWorkWindow(v1, { vacation: true }).workWindow, undefined, 'explicit vacation clears v1 work window')
}

async function assertDshRunTurn(
  packPath: string,
  profileWindow: WorkWindowProfile,
  expectation: { homeZone?: string; feasible: boolean; hasExclusion: boolean },
): Promise<void> {
  const previousFetch = globalThis.fetch
  const previousEnv = {
    key: process.env['LLM_API_KEY'],
    model: process.env['LLM_MODEL'],
    base: process.env['LLM_BASE_URL'],
  }
  let calls = 0
  globalThis.fetch = (async () => {
    calls++
    const content = calls === 1
      ? JSON.stringify({
        calendar: { year: 2026, assertedWeekdays: { '2026-07-04': 'sat' } },
        profile: { workWindow: profileWindow, bookedResources: [{ kind: 'hotel', ref: 'fixture', window: '2026-07-04~2026-07-05' }] },
      })
      : calls === 2
        ? JSON.stringify({ scenario: 'workation', segments: [{ id: 'l1', anchors: {} }] })
        : '{}'
    return new Response(JSON.stringify({
      choices: [{ message: { content } }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    }), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
  process.env['LLM_API_KEY'] = 'fixture-key'
  process.env['LLM_MODEL'] = 'fixture-model'
  process.env['LLM_BASE_URL'] = 'https://fixture.invalid/v1'
  try {
    const llm = createOpenAICompatLlm(packPath, () => new Date('2026-07-01T00:00:00Z'))
    const result = await runTurn(
      initialState(),
      '请给我做机票和酒店的行程规划和推荐，工作时间，订了酒店',
      llm,
      [],
      solveUnified as unknown as SolvePort,
      new Date('2026-07-01T00:00:00Z'),
    )
    assert.equal(calls, 3)
    assert.equal(result.state.spec?.workWindow?.homeZone, expectation.homeZone)
    assert.equal(result.state.solve?.feasible, expectation.feasible)
    const exclusions = result.state.solve?.work_window_exclusions ?? []
    if (expectation.hasExclusion) {
      const exclusion = exclusions.find(e => e.option === 's1')
      assert.ok(exclusion)
      assert.match(exclusion!.reason, /周五/)
      assert.match(exclusion!.reason, /14:30/)
      assert.match(result.reply, /工作窗口/)
    } else {
      assert.equal(exclusions.length, 0)
      assert.doesNotMatch(result.reply, /工作窗口/)
    }
  } finally {
    globalThis.fetch = previousFetch
    if (previousEnv.key === undefined) delete process.env['LLM_API_KEY']
    else process.env['LLM_API_KEY'] = previousEnv.key
    if (previousEnv.model === undefined) delete process.env['LLM_MODEL']
    else process.env['LLM_MODEL'] = previousEnv.model
    if (previousEnv.base === undefined) delete process.env['LLM_BASE_URL']
    else process.env['LLM_BASE_URL'] = previousEnv.base
  }
}

async function assertMockEntry(packPath: string): Promise<void> {
  const llm = createMockLlm(packPath)
  const state = initialState()
  state.profile = {
    workWindow: { ...schedule, homeTzOffsetMin: 777 },
    bookedResources: [{ kind: 'hotel', ref: 'fixture' }],
  }
  const spec = await llm.extractSpec([], state)
  assert.equal(spec?.workWindow?.homeZone, 'America/Los_Angeles')
  assert.equal(spec?.budgetCny, 9000)
}

const root = await mkdtemp(join(tmpdir(), 'gotry-343-real-entry-'))
try {
  const packPath = join(root, 'flights_2026.json')
  await writeFile(packPath, JSON.stringify(v2Pack), 'utf8')
  assertPrecedence()
  await assertDshRunTurn(packPath, { ...schedule, homeTzOffsetMin: 777 }, {
    homeZone: 'America/Los_Angeles', feasible: false, hasExclusion: true,
  })
  await assertDshRunTurn(packPath, schedule, {
    homeZone: 'America/Los_Angeles', feasible: false, hasExclusion: true,
  })
  await assertDshRunTurn(packPath, { vacation: true }, {
    homeZone: undefined, feasible: true, hasExclusion: false,
  })
  await assertMockEntry(packPath)
  assert.equal((await readFile(packPath, 'utf8')).includes('America/Los_Angeles'), true)
  console.log('ISSUE 343 REAL-ENTRY E2E: precedence, runTurn, mock, v1/v2 typed contract OK')
} finally {
  await rm(root, { recursive: true, force: true })
}
