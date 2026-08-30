/**
 * interpretArgs 形态回归(④XML 标签串/⑤JSON 字符串):真 LLM 对话实测暴露的两形态。
 * 运行: cd ts && npx tsx scripts/dbg-args.ts
 */
import assert from 'node:assert/strict'
import { interpretArgs } from '../src/tool-packet.ts'
const x4 = interpretArgs<{ hotelId?: unknown }>({ query: '<hotelId>900000001</hotelId><checkIn>2026-10-10</checkIn><adults>1</adults>' })
assert.equal(String(x4.hotelId), '900000001', '④ XML 标签串解析')
assert.equal(x4.checkIn, '2026-10-10')
const x5 = interpretArgs<{ hotelId?: unknown }>({ query: '{"hotelId":"900000001","checkIn":"2026-10-10"}' })
assert.equal(String(x5.hotelId), '900000001', '⑤ JSON 字符串解析')
const x3 = interpretArgs<{ destination?: string }>({ query: '大理' }, 'destination')
assert.equal(x3.destination, '大理', '③ 主键字符串不回归')
const x2 = interpretArgs<{ a?: number }>({ query: { a: 1 } })
assert.equal(x2.a, 1, '① 对象形态不回归')
const x1 = interpretArgs<{ a?: number }>({ a: 2 })
assert.equal(x1.a, 2, '② 平铺形态不回归')
console.log('INTERPRET-ARGS FORMS: 5/5 OK(①对象/②平铺/③主键串/④XML标签串/⑤JSON串)')
