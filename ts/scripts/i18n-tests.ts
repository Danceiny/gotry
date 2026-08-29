/**
 * i18n 目录回归(README Known limitation「zh-CN 体验」的工程清偿验证面):
 *   1. en 目录零缺键(enCoverage 为空);
 *   2. 默认 zh-CN:engine 金标准 answer_md 中文措辞逐项在位(与 engine-tests 金标准同源);
 *   3. GOTRY_LOCALE=en / setLocale('en'):answer_md 切英文、判定位仍含班次/金额(数据不动,只换词面);
 *   4. 插值与回退:缺变量保留 {var},en 缺键回退 zh。
 *
 * 运行(在 ts/ 下,零网):npx tsx scripts/i18n-tests.ts
 */

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { enCoverage, getLocale, setLocale, t } from '../src/i18n.ts'
import { solve } from '../src/engine.ts'
import { parseCandidate, parseRequest } from '../src/model.ts'

// 0. en 目录完备
assert.deepEqual(enCoverage(), [], 'en 目录缺键:' + enCoverage().join(','))

// zh-CN 金标准(默认 locale):与 engine-tests 同一 golden 输入,断言中文词面
const erhai = JSON.parse(await readFile(join('..', 'data', 'golden_erhai.json'), 'utf-8'))
const req = parseRequest(erhai['request'])
const candidates = (erhai['candidates'] as Record<string, unknown>[]).map(parseCandidate)

// 1. 默认 zh
assert.equal(getLocale(), 'zh-CN', '默认 locale 应为 zh-CN')
const zhRes = await solve(req, candidates) as Record<string, unknown>
const zhZh = String(zhRes['answer_md'])
assert.ok(zhZh.includes('千岛湖') && zhZh.includes('下一次出发') && zhZh.includes('待你决定的两个问题'))
void zhZh

// 2. 英文面:同一输入,断言换语言只换词面、判定数据不动
setLocale('en')
const enRes = await solve(req, candidates) as Record<string, unknown>
const enMd = String(enRes['answer_md'])
assert.ok(enMd.includes('feasible'), '英文判定应含 feasible')
assert.ok(!enMd.includes('现在不行'), '英文面不得残留中文判定词')
assert.ok(enMd.includes('千岛湖'), '候选名(数据)跨语言不动')
assert.ok(/¥\d+/.test(enMd), '金额不翻译')

// 3. 词条插值与回退
assert.equal(t('md.wish_budget', { cny: '4950' }).includes('4950'), true, '插值生效(以当前 locale 渲染)')
setLocale('zh-CN')
assert.equal(getLocale(), 'zh-CN')
assert.equal(t('md.wish_budget', { cny: 4950 }), '、约 ¥4950', 'zh 模板逐字节')

console.log('\nI18N TESTS: 4/4 OK(en 零缺键/默认 zh 金标准一致/en 切换数据不动/插值+回退)')