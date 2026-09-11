/**
 * Issue #363 — 航班/酒店锚点字段指纹(注册 `gotry_fact_gate` 路径 E2E)。
 *
 * 真实执行面:在临时 stateRoot 下装载 gotry-tools 插件,通过 `apply(ctx, config)`
 * 装载注册定义,捕获 `gotry_fact_gate` 的 execute 函数,以 markdown 直接调用——
 * 经注册的 tool definition 走完 `loadFactRegistry(stateRoot)` → `gateArtifact`
 * 公共闸侧路径,完整覆盖 D-26 / D-30 残余收口。
 * 不启动 dsh 宿主、不调用真实 ToolRuntime、不触碰供应商 / browser / policy
 * service / 共享状态。
 *
 * 测试面与 §15 一致:
 *   - 3 个根反例 + canonical 各 1 行(共 5)——以注册闸执行;
 *   - §4b 价格兼容:总预算/行李费/总计/显式票价/千分位 等形态不被字段指纹吞并;
 *   - 价格矛盾仍走 price_contradicted,不退化为 fact_anchor_unknown;
 *   - 列车/政策 canonical 不被新字段指纹吞并。
 *
 * 运行(在 ts/ 下):
 *   PATH=/opt/homebrew/opt/node@24/bin:$PATH \
 *     npx tsx scripts/flight-hotel-anchor-363-registered-e2e.ts
 */

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { Context } from '@deepseek-ai/cordis'
import { apply } from '../src/index.ts'
import {
  BOOKABLE_FACT_SCHEMA,
  factsFromFlyai,
  factsFromHotel,
  makeFactId,
  renderFlightFact,
  renderHotelFact,
  renderPolicyFact,
  type FlightFact,
  type HotelFact,
  type PolicyFact,
} from '../src/bookable-facts.ts'
import { appendFacts } from '../capabilities/fact-log.ts'
import type { AirlineAirportMap } from '../src/artifact-gate.ts'

const FETCHED = '2026-08-29T09:51:00.000Z'
const HOTEL_FETCHED = '2026-09-04T00:00:00.000Z'

interface ToolDef {
  name: string
  execute: (args: Record<string, unknown>, exec: unknown) => Promise<unknown>
  output: { render: (args: Record<string, unknown>, result: unknown) => Array<{ type?: string; text?: string }> }
}

async function main(): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), 'gotry-363-flight-hotel-anchor-'))
  const stateRoot = join(home, 'state')
  const cwd = join(home, 'workspace')
  mkdirSync(stateRoot, { recursive: true })
  mkdirSync(cwd, { recursive: true })

  // 与根反例 fixture 同源:UO724 HKG→HKT 2027-07-17(bookable_exact_date)。
  const map = JSON.parse(await import('node:fs/promises').then(m => m.readFile(
    join(import.meta.dirname, '..', '..', 'data', 'airline-airports.json'), 'utf-8',
  ))) as AirlineAirportMap
  const flight = factsFromFlyai(
    { kind: 'flight', origin: '香港', destination: '普吉', date: '2027-07-17' },
    {
      verdict: 'hit',
      options: [{
        no: 'UO724', name: '香港快运航空',
        depDateTime: '2027-07-17T07:55:00', arrDateTime: '2027-07-17T10:30:00',
        depStation: 'HKG', arrStation: 'HKT',
        price: 793, nonstop: true,
      }],
    },
    FETCHED,
    map.city_alias,
  )[0]!

  const hotel = factsFromHotel({
    source: 'flyai-hotel', destination: '大理',
    checkIn: '2026-10-01', checkOut: '2026-10-03',
    verdict: 'hit', options: 9, evidence: 'synthetic', fetchedAt: HOTEL_FETCHED,
  })[0]!

  const policy: PolicyFact = {
    schema: BOOKABLE_FACT_SCHEMA,
    fact_id: makeFactId(['policy-363', 'reg', '泰国免签']),
    kind: 'policy',
    subject: '泰国入境(中国护照)',
    statement: '免签停留(口径以泰方公告为准);UAE 居民返程应优先校验 residence visa / Emirates ID 而非游客免签口径',
    source: 'web:official',
    query_id: 'web:policy:泰国免签',
    fetched_at: FETCHED,
    as_of: '2026-08-29',
  }

  // 走真实事实日志路径(append-only JSONL),与产品 gotry_flyai_search /
  // gotry_session_search 同款事实落账接口;闸侧 loadFactRegistry 直接读这里。
  await appendFacts(stateRoot, [flight, hotel, policy])

  // 装载 gotry-tools 插件 → 捕获 gotry_fact_gate 的真实 execute。
  const registered: ToolDef[] = []
  const ctx = {
    tools: { register: (t: unknown) => registered.push(t as ToolDef) },
    systemPrompt: { section: () => undefined, variable: () => undefined },
    on: () => () => undefined,
  } as unknown as Context
  apply(ctx, {
    stateRoot,
    timeoutMs: 30_000,
    hbcliBin: 'hbcli-not-on-path',
    sessionAccess: 'off',
  })
  const factGate = registered.find(t => t.name === 'gotry_fact_gate')
  if (!factGate) throw new Error(`FAIL: 注册定义列表缺少 gotry_fact_gate,实际注册: ${registered.map(t => t.name).join(',')}`)
  const exec = { agent: { session: { header: { cwd } } } }

  const flightCanonical = renderFlightFact(flight)
  const hotelCanonical = renderHotelFact(hotel)

  // Case 1:canonical flight 行经真实 gotry_fact_gate → pass
  const r1 = await factGate.execute({ markdown: ['## 航班', flightCanonical].join('\n') }, exec) as { verdict?: string; traceable?: number; summary?: string }
  assert.equal(r1.verdict, 'pass', `canonical flight 经注册闸应 pass,实际: ${JSON.stringify({ verdict: r1.verdict, summary: r1.summary })}`)
  assert.equal(r1.traceable, 1)
  console.log('  ok - 注册 gotry_fact_gate canonical flight → pass')

  // Case 2:canonical hotel 行经真实 gotry_fact_gate → pass
  const r2 = await factGate.execute({ markdown: ['## 住宿', hotelCanonical].join('\n') }, exec) as { verdict?: string; traceable?: number; summary?: string }
  assert.equal(r2.verdict, 'pass', `canonical hotel 经注册闸应 pass,实际: ${JSON.stringify({ verdict: r2.verdict, summary: r2.summary })}`)
  assert.equal(r2.traceable, 1)
  console.log('  ok - 注册 gotry_fact_gate canonical hotel → pass')

  // Case 3:flight_no 改写(UO724 → UO999),保留 anchor → blocked/fact_anchor_unknown
  const tamperedFlight = flightCanonical.replace('UO724', 'UO999')
  const r3 = await factGate.execute({ markdown: ['## 航班', tamperedFlight].join('\n') }, exec) as { verdict?: string; traceable?: number; violations?: Array<{ kind?: string }>; summary?: string }
  assert.equal(r3.verdict, 'blocked', `flight_no 改写经注册闸应 blocked,实际: ${JSON.stringify({ verdict: r3.verdict, summary: r3.summary })}`)
  assert.equal(r3.traceable, 0)
  assert.ok(r3.violations?.some(v => v.kind === 'fact_anchor_unknown' && /UO999|UO724/.test(JSON.stringify(v))),
    `flight_no 改写应有 fact_anchor_unknown,实际: ${JSON.stringify(r3.violations?.map(v => v.kind))}`)
  console.log('  ok - 注册 gotry_fact_gate flight_no UO724→UO999 → blocked/fact_anchor_unknown')

  // Case 4:hotel destination 改写(大理 → 丽江)→ blocked/fact_anchor_unknown
  const tamperedHotelDest = hotelCanonical.replace('大理', '丽江')
  const r4 = await factGate.execute({ markdown: ['## 住宿', tamperedHotelDest].join('\n') }, exec) as { verdict?: string; traceable?: number; violations?: Array<{ kind?: string }>; summary?: string }
  assert.equal(r4.verdict, 'blocked', `hotel destination 改写经注册闸应 blocked,实际: ${JSON.stringify({ verdict: r4.verdict, summary: r4.summary })}`)
  assert.ok(r4.violations?.some(v => v.kind === 'fact_anchor_unknown'),
    `hotel destination 改写应有 fact_anchor_unknown,实际: ${JSON.stringify(r4.violations?.map(v => v.kind))}`)
  console.log('  ok - 注册 gotry_fact_gate hotel destination 大理→丽江 → blocked/fact_anchor_unknown')

  // Case 5:hotel date 改写(2026-10-01 → 2026-12-25)→ blocked/fact_anchor_unknown
  const tamperedHotelDate = hotelCanonical.replace('2026-10-01', '2026-12-25')
  const r5 = await factGate.execute({ markdown: ['## 住宿', tamperedHotelDate].join('\n') }, exec) as { verdict?: string; traceable?: number; violations?: Array<{ kind?: string }>; summary?: string }
  assert.equal(r5.verdict, 'blocked', `hotel date 改写经注册闸应 blocked,实际: ${JSON.stringify({ verdict: r5.verdict, summary: r5.summary })}`)
  assert.equal(r5.traceable, 0)
  assert.ok(r5.violations?.some(v => v.kind === 'fact_anchor_unknown'),
    `hotel date 改写应有 fact_anchor_unknown,实际: ${JSON.stringify(r5.violations?.map(v => v.kind))}`)
  console.log('  ok - 注册 gotry_fact_gate hotel date 2026-10-01→2026-12-25 → blocked/fact_anchor_unknown')

  // Case 6:§4b 价格兼容——尾随总预算 → 不被 fact_anchor_unknown 吞并
  const appendedBudget = `${flightCanonical}；总预算¥1000`
  const r6 = await factGate.execute({ markdown: ['## 航班', appendedBudget].join('\n') }, exec) as { verdict?: string; violations?: Array<{ kind?: string }>; summary?: string }
  assert.equal(r6.verdict, 'pass', `尾随总预算经注册闸应 pass,实际: ${JSON.stringify({ verdict: r6.verdict, summary: r6.summary })}`)
  assert.ok(!r6.violations?.some(v => v.kind === 'fact_anchor_unknown'),
    `尾随总预算不应有 fact_anchor_unknown,实际: ${JSON.stringify(r6.violations?.map(v => v.kind))}`)
  console.log('  ok - 注册 gotry_fact_gate flight §4b 价格兼容(尾随总预算)→ pass')

  // Case 7:§4b 价格兼容——证据链前裸金额(¥999)→ 走 unverified_price_claim,
  //     不退化为 fact_anchor_unknown
  const bareAmount = flightCanonical.replace(' [flyai@', '；¥999 [flyai@')
  const r7 = await factGate.execute({ markdown: ['## 航班', bareAmount].join('\n') }, exec) as { verdict?: string; violations?: Array<{ kind?: string }>; summary?: string }
  assert.equal(r7.verdict, 'blocked', `证据链前裸金额经注册闸应 blocked,实际: ${JSON.stringify({ verdict: r7.verdict, summary: r7.summary })}`)
  assert.ok(r7.violations?.some(v => v.kind === 'unverified_price_claim'),
    `证据链前裸金额应有 unverified_price_claim,实际: ${JSON.stringify(r7.violations?.map(v => v.kind))}`)
  assert.ok(!r7.violations?.some(v => v.kind === 'fact_anchor_unknown'),
    `证据链前裸金额不应有 fact_anchor_unknown,实际: ${JSON.stringify(r7.violations?.map(v => v.kind))}`)
  console.log('  ok - 注册 gotry_fact_gate flight §4b 价格兼容(证据链前裸金额)→ blocked/unverified_price_claim')

  // Case 8:§4b 价格矛盾(¥999 替换 ¥793)→ price_contradicted 分类保留,
  //     不退化为 fact_anchor_unknown
  const contradicted = flightCanonical.replace('¥793', '¥999')
  const r8 = await factGate.execute({ markdown: ['## 航班', contradicted].join('\n') }, exec) as { verdict?: string; violations?: Array<{ kind?: string }>; summary?: string }
  assert.equal(r8.verdict, 'blocked', `价格矛盾经注册闸应 blocked,实际: ${JSON.stringify({ verdict: r8.verdict, summary: r8.summary })}`)
  assert.ok(r8.violations?.some(v => v.kind === 'price_contradicted'),
    `价格矛盾应有 price_contradicted,实际: ${JSON.stringify(r8.violations?.map(v => v.kind))}`)
  assert.ok(!r8.violations?.some(v => v.kind === 'fact_anchor_unknown'),
    `价格矛盾不应有 fact_anchor_unknown,实际: ${JSON.stringify(r8.violations?.map(v => v.kind))}`)
  console.log('  ok - 注册 gotry_fact_gate flight §4b 价格矛盾 → blocked/price_contradicted(分类保留)')

  // Case 9:整行改写(flight_no + 价格)→ fact_anchor_unknown(字段级别 fail-closed 优先)
  const allTampered = flightCanonical.replace('UO724', 'UO999').replace('¥793', '¥1000')
  const r9 = await factGate.execute({ markdown: ['## 航班', allTampered].join('\n') }, exec) as { verdict?: string; violations?: Array<{ kind?: string }>; summary?: string }
  assert.ok(r9.violations?.some(v => v.kind === 'fact_anchor_unknown'),
    `flight 字段 + 价格联合改写应有 fact_anchor_unknown,实际: ${JSON.stringify(r9.violations?.map(v => v.kind))}`)
  console.log('  ok - 注册 gotry_fact_gate flight 字段+价格联合改写 → fact_anchor_unknown')

  // Case 10:借用合法 fact_id 写入乱码 flight_no → fact_anchor_unknown
  const borrowedAnchor = `## 航班\n- HKG→HKT 2027-07-17 XX9999(未知) 07:55→10:30 直飞 ¥793 [flyai@${flight.fetched_at} #${flight.query_id}] <!-- fact:${flight.fact_id} -->`
  const r10 = await factGate.execute({ markdown: borrowedAnchor }, exec) as { verdict?: string; violations?: Array<{ kind?: string }>; summary?: string }
  assert.ok(r10.violations?.some(v => v.kind === 'fact_anchor_unknown'),
    `借用合法 fact_id 写入乱码 flight_no 应有 fact_anchor_unknown,实际: ${JSON.stringify(r10.violations?.map(v => v.kind))}`)
  console.log('  ok - 注册 gotry_fact_gate 借用合法 fact_id + 乱码 flight_no → fact_anchor_unknown')

  // Case 11:列车 canonical 形态保留——列车 kind 不走 flight_no 字段指纹
  const gTrain = factsFromFlyai(
    { kind: 'train', origin: '香港', destination: '普吉', date: '2027-07-17' },
    { verdict: 'hit', options: [{ no: 'G1234', depDateTime: '2027-07-17T09:00:00', arrDateTime: '2027-07-17T13:00:00' }] },
    FETCHED,
    map.city_alias,
  )[0]!
  await appendFacts(stateRoot, [gTrain])
  const trainRendered = renderFlightFact(gTrain)
  const r11 = await factGate.execute({ markdown: ['## 车次', trainRendered].join('\n') }, exec) as { verdict?: string; traceable?: number; violations?: Array<{ kind?: string }>; summary?: string }
  assert.equal(r11.verdict, 'pass', `train canonical 经注册闸应 pass,实际: ${JSON.stringify({ verdict: r11.verdict, summary: r11.summary })}`)
  assert.ok(!r11.violations?.some(v => v.kind === 'fact_anchor_unknown'),
    `train canonical 不应有 fact_anchor_unknown,实际: ${JSON.stringify(r11.violations?.map(v => v.kind))}`)
  console.log('  ok - 注册 gotry_fact_gate train canonical → pass(列车/航班分类独立,不被字段指纹吞并)')

  // Case 12:政策锚点形态保留——政策行不受 flight_no/destination/check_in 字段指纹影响
  const policyLine = renderPolicyFact(policy)
  const r12 = await factGate.execute({ markdown: ['## 政策', policyLine].join('\n') }, exec) as { verdict?: string; traceable?: number; violations?: Array<{ kind?: string }>; summary?: string }
  assert.equal(r12.verdict, 'pass', `policy canonical 经注册闸应 pass,实际: ${JSON.stringify({ verdict: r12.verdict, summary: r12.summary })}`)
  assert.ok(!r12.violations?.some(v => v.kind === 'fact_anchor_unknown'),
    `policy canonical 不应有 fact_anchor_unknown,实际: ${JSON.stringify(r12.violations?.map(v => v.kind))}`)
  console.log('  ok - 注册 gotry_fact_gate policy canonical → pass(政策不受新字段指纹影响)')

  // Case 13:借用合法 fact_id 写入伪造酒店 destination → blocked/fact_anchor_unknown
  const borrowedHotel = `## 住宿\n- 丽江 2026-10-01→2026-10-03:住宿已核验(在架 9 家;价格上游打码,真实价以落地页为准) <!-- fact:${hotel.fact_id} -->`
  const r13 = await factGate.execute({ markdown: borrowedHotel }, exec) as { verdict?: string; violations?: Array<{ kind?: string }>; summary?: string }
  assert.ok(r13.violations?.some(v => v.kind === 'fact_anchor_unknown'),
    `借用合法 hotel fact_id 写入伪造 destination 应有 fact_anchor_unknown,实际: ${JSON.stringify(r13.violations?.map(v => v.kind))}`)
  console.log('  ok - 注册 gotry_fact_gate 借用合法 hotel fact_id + 伪造 destination → fact_anchor_unknown')

  rmSync(home, { recursive: true, force: true })
  console.log('\nFLIGHT/HOTEL ANCHOR #363 REGISTERED E2E: pass (deterministic synthetic, isolated stateRoot, registered gotry_fact_gate execute(), no host ToolRuntime / no live inventory)')
}

await main()
