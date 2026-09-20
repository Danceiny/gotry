/** Offline registration contract for the eight public FlyAI search kinds. */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { apply, type Config } from '../src/index.ts'

const stateRoot = await mkdtemp(join(tmpdir(), 'gotry-flyai-registration-'))
const calls: Array<{ effect: string; params: Record<string, unknown>; signal?: AbortSignal }> = []
const tools: Array<Record<string, any>> = []
const context = {
  tools: { register: (tool: unknown) => tools.push(tool as Record<string, any>) },
  systemPrompt: { variable: () => {} },
  on: () => () => {},
  get: () => undefined,
} as unknown as Context
const config: Config = { stateRoot, timeoutMs: 5_000, hbcliBin: 'unavailable', sessionAccess: 'off' }
const effect = async (input: { effect: string; params: Record<string, unknown>; signal?: AbortSignal }) => {
  calls.push(input)
  return {
    result: {
      ok: false,
      via: 'flyai',
      kind: input.params.kind,
      verdict: 'miss',
      evidence: '[contract-test:flyai]',
    },
    trace: {},
  }
}

apply(context, config, { effect: effect as never })
const search = tools.find(tool => tool.name === 'gotry_flyai_search')
assert.ok(search, 'apply must register gotry_flyai_search')
assert.ok(tools.some(tool => tool.name === 'gotry_flyai_setup'), 'apply must register gotry_flyai_setup')

const publicSchema = JSON.stringify(search.parameters)
for (const forbidden of ['cliBin', 'cliPrefixArgs', 'credential', 'apiKey', 'endpoint', 'signal']) {
  assert.equal(publicSchema.includes(forbidden), false, `search schema must not expose ${forbidden}`)
}
assert.deepEqual(search.parameters.properties.kind.enum, [
  'flight', 'train', 'hotel', 'poi', 'keyword', 'ai', 'marriott-hotel', 'marriott-package',
])

const signal = new AbortController().signal
const queries: Array<Record<string, unknown>> = [
  { kind: 'flight', from: '上海' },
  { kind: 'train', origin: '上海', destination: '大理', depDateStart: '2099-10-01', depDateEnd: '2099-10-03' },
  { kind: 'hotel', to: '大理' },
  { kind: 'poi', cityName: '大理', category: '自然风光' },
  { kind: 'keyword', query: '大理古城' },
  { kind: 'ai', query: '大理周末' },
  { kind: 'marriott-hotel', destName: '大理' },
  { kind: 'marriott-package', keyword: '早餐' },
]
for (const query of queries) {
  const result: Record<string, unknown> = await search.execute(query, { signal })
  assert.equal(result.verdict, 'miss', `registered ${String(query.kind)} should execute`)
  const call = calls.at(-1)
  assert.ok(call, `${String(query.kind)} should reach the effect seam`)
  assert.equal(call?.effect, 'FLYAI_SEARCH')
  assert.equal(call?.params.kind, query.kind)
  assert.equal(call?.params.signal, signal, `${String(query.kind)} must receive params.signal`)
  assert.equal(call?.signal, signal, `${String(query.kind)} must preserve outer cancellation`)
  assert.equal('cliBin' in (call?.params ?? {}), false)
  assert.equal('credential' in (call?.params ?? {}), false)
  assert.equal('endpoint' in (call?.params ?? {}), false)
}

const callsBeforeUnknown = calls.length
const unknown = await search.execute({ kind: 'spaceship', from: '上海', to: '月球', date: '2099-10-01' }, { signal })
assert.equal(calls.length, callsBeforeUnknown, 'unknown kind must be rejected before the effect')
assert.equal((unknown as Record<string, unknown>).ok, false)
for (const invalid of [
  { kind: 'flight', to: '丽江' },
  { kind: 'flight', from: '上海', date: '2099-02-29' },
  { kind: 'train', from: '上海', dateStart: '2099-10-03', dateEnd: '2099-10-01' },
  { kind: 'flight', from: '上海', sortType: '9' },
  { kind: 'marriott-hotel', destName: '大理', hotelStars: '5' },
  { kind: 'poi', cityName: '' },
  { kind: 'keyword' },
  { kind: 'marriott-package' },
]) {
  const before = calls.length
  const rejected: Record<string, unknown> = await search.execute(invalid, { signal })
  assert.equal(calls.length, before, `${String(invalid.kind)} missing required input must not reach the effect`)
  assert.equal(rejected.ok, false)
}

const marriott = await search.execute({ kind: 'marriott-hotel', destName: '大理', hotelBrands: '万豪', hotelName: '大理酒店' }, { signal }) as Record<string, unknown>
assert.equal(marriott.verdict, 'miss')
const marriottCall = calls.at(-1)
assert.equal(marriottCall?.params.keyWords, '万豪 大理酒店', 'Marriott name/brand must map to official --key-words')
assert.equal('hotelBrands' in (marriottCall?.params ?? {}), false)
assert.equal('hotelName' in (marriottCall?.params ?? {}), false)

await rm(stateRoot, { recursive: true, force: true })
console.log('flyai registration contract OK')
