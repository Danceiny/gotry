/**
 * 实时票价 overlay 回归(FlyAI 实时桥 + 静态降级,三值语义;纯离线——查询注入,零网):
 *   1. hit:dated 段按航班号精确匹配 → 价格覆写 + `[实时API:flyai@ts]` 证据链 + 静态原价留档;
 *   2. error/miss:段原样保留(静态价即降级),降级证据行进 notes;
 *   3. 非 YYYY-MM-DD 日期段(如「2026-07-31 或 08-01」):不查询、不触碰;
 *   4. 无匹配航班号/打码价(NaN):不覆写不抛错;
 *   5. 求解集成:覆写后的 spec 进 solveUnified 判定可算、钱不低于降价前。
 *
 * 运行(在 ts/ 下,零网):npx tsx scripts/realtime-pricing-tests.ts
 */

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { overlayRealtimeFlightPrices, type RealtimeQueryPort } from '../src/realtime-pricing.ts'
import { parseFlightPackToSpec, solveUnified } from '../src/unified.ts'
import type { FlyaiOption, FlyaiResult } from '../capabilities/flyai.ts'

const packJson = JSON.parse(await readFile(join('..', 'data', 'flights_2026.json'), 'utf-8')) as Record<string, unknown>

function hit(no: string, price: number): FlyaiResult {
  const opt: FlyaiOption = {
    no, name: '测试航司',
    depDateTime: '2026-07-18 14:45:00', arrDateTime: '2026-07-18 17:20:00',
    depStation: 'HKG', arrStation: 'HKT', durationMin: 155, price,
  }
  return { ok: true, via: 'flyai', verdict: 'hit', kind: 'flight', evidence: '[实时API:flyai@2026-08-29T06:00:00.000Z] hit', latencyMs: 1, options: [opt] }
}
function err(): FlyaiResult {
  return { ok: false, via: 'flyai-error', verdict: 'error', kind: 'flight', evidence: '[实时API:flyai@error@2026-08-29T06:00:00.000Z] synthetic-timeout', latencyMs: 1, error: 'synthetic-timeout' }
}

const queries: Array<{ origin: string; destination: string; depDate: string }> = []
const query: RealtimeQueryPort = async q => {
  queries.push(q)
  // f1 香港→普吉:仅 CX773 有实时价(1200),HX741 无条目(无匹配分支)
  return q.origin === '香港' ? hit('CX773', 1200) : err() // f5 深圳→迪拜:error 降级分支
}

// 五段链 spec:f1(HKG->HKT, 2026-07-18)、f5(SZX->DXB, 2026-08-10)进查询;
// f2/f3 日期为「2026-07-31 或 08-01」非严格形 → 词表/日期闸跳过;f4 无 arrive_by 仍是 dated。
const overlay = await overlayRealtimeFlightPrices(parseFlightPackToSpec(packJson), { query })

// 1. hit 覆写:仅精确匹配的 CX773 被覆写,静态原价留档在证据链里
assert.equal(overlay.matched.length, 1, '仅 CX773 命中覆写(1 条)')
const m = overlay.matched[0]!
assert.equal(m.segment, 'f1')
assert.equal(m.option, 'CX773')
assert.equal(m.staticCny, 2300)
assert.equal(m.realtimeCny, 1200)
assert.ok(m.evidence.includes('[实时API:flyai@2026-08-29T06:00:00.000Z]'), '证据链带时间戳')
assert.ok(m.evidence.includes('静态包原价 ¥2300'), '静态原价留档')

const f1svc = (id: string): number => overlay.spec.segments.find(s => s.id === 'f1')!.options.find(o => o.id === id)!.move!.services[0].priceCny
assert.equal(f1svc('CX773'), 1200, '实时价覆写进 spec')
assert.equal(f1svc('HX741'), 1600, '无匹配条目原价保留')

// 2. error 降级:f5 段原样 + 降级证据行
const f5svc = overlay.spec.segments.find(s => s.id === 'f5')!.options[0]!.move!.services[0]
assert.equal(f5svc.id, 'EK329')
assert.equal(f5svc.priceCny, 3400, 'error 段不覆写')
assert.ok(overlay.notes.some(n => n.startsWith('f5:') && n.includes('未取回(error')), 'error 降级证据行存在')

// 3. 查询面:仅 dated + route 词表内城市对的段被查询(f1/f4/f5;f2/f3 非严格日期不查)
assert.equal(queries.length, 3, '仅 f1/f4/f5 被查询(f2/f3 非严格日期)')
assert.deepEqual(queries.map(q => q.origin), ['香港', '深圳', '昆明'])
// f4(昆明→深圳)error 降级:两班原价不动
const f4prices = overlay.spec.segments.find(s => s.id === 'f4')!.options.map(o => o.move!.services[0].priceCny)
assert.deepEqual(f4prices, [1150, 980, 700], 'f4 error 段原价保留')

// 4. 求解集成:覆写后 spec 判定可算(价格只降,结果钱 ≤ 基线)
const baseline = await solveUnified(parseFlightPackToSpec(packJson))
const overlaid = await solveUnified(overlay.spec)
assert.equal(overlaid.feasible, true, '覆写后 spec 求解可行')
assert.ok(baseline.money_cny !== undefined && overlaid.money_cny !== undefined, '两条路径都出总价')
assert.ok(overlaid.money_cny! <= baseline.money_cny!, '实时价不抬高求解总钱')

// 5. 无 dated 段 spec:零查询零改动(结构化直验)
const bare = await overlayRealtimeFlightPrices({
  note: 'no-dates',
  segments: [{
    id: 'dest', role: 'choice',
    options: [{ id: 'a', label: 'x', move: { hub: 'SZX', services: [{ id: 'EK329', depMin: 45, arrMin: 260, priceCny: 3400 }], bufferMin: 30, originTransferMin: 0, destTransferMin: 30 } }],
  }],
})
assert.equal(bare.matched.length, 0, '无 dated 段 → 不查询')
assert.equal(bare.spec.segments[0]!.options[0]!.move!.services[0].priceCny, 3400, '价格原样')

console.log('\nREALTIME PRICING TESTS: 5/5 OK(hit 覆写+证据/error 降级/日期词表闸/求解集成/无段零触碰)')