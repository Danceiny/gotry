/**
 * 时间感评测(时间锚点层 + travel_slot_extraction.v1 槽位抽取):
 *
 * 确定性部分(进 CI,run-all-tests.sh 挂载):
 *  1. 锚点卡:固定 now=2026-08-27(周四)断言关键换算(下周一/大后天/下下周四/下个月中旬/季度/节日)
 *  2. 过期校验 flagExpiredSlots:绝对月日早于锚点今天判过期;相对表达永不判;幂等
 *  3. 评分器 scoreExtraction 自测(通过/语言/域/槽位值/missing_slots/多键 warning)
 *  4. mock 回放管道:25 题 golden 经 mock 回吐,评分管道应 25/25(管道自测,与模型质量解耦)
 *
 * 真模型巡检(只读报告,不进 CI 红线;ADR-11 质量层定位):
 *  cd ts && npx tsx scripts/time-eval-tests.ts --real
 *  需 LLM_API_KEY(或 DEEPSEEK_API_KEY;仓根 .env 亦可)。锚点固定 anchor_date=2026-08-27
 *  (golden 的过期判定依赖它,见数据文件 note)。只读:不碰 gotry-state(巡检状态纪律)。
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildTimeAnchor, parseAbsoluteDate } from '../src/time-anchor.ts'
import { detectLanguage, flagExpiredSlots, scoreExtraction, type TravelSlotExtraction } from '../src/travel-slots.ts'
import { resolveSlotDate, resolveSlots, specDateMismatches, type ResolvedSlots } from '../src/slot-spec.ts'
import { createMockLlm, type SlotScriptStep } from '../src/mock-llm.ts'
import { createOpenAICompatLlm } from '../src/dsh-llm.ts'

interface EvalCase {
  id: string
  priority: string
  note: string
  utterance: string
  expected: TravelSlotExtraction
}
interface EvalSet { anchor_date: string; cases: EvalCase[] }

const dataset = JSON.parse(readFileSync(join('..', 'data', 'time-slot-eval.json'), 'utf-8')) as EvalSet
const [ay, am, ad] = dataset.anchor_date.split('-').map(Number)
const ANCHOR_NOW = new Date(ay, am - 1, ad, 12) // 锚点日中午,避免午夜边界

// ---- 1. 锚点卡(固定 now 断言) ------------------------------------------------
{
  const a = buildTimeAnchor(ANCHOR_NOW)
  assert.equal(a.today, '2026-08-27', 'today')
  assert.equal(a.todayWeekdayZh, '周四', '2026-08-27 是周四')
  assert.match(a.tzLabel, /^UTC[+-]\d/, '时区标注格式')
  const c = a.card
  assert.ok(c.includes('明天 2026-08-28 周五'), '明天')
  assert.ok(c.includes('大后天 2026-08-30 周日'), '大后天')
  assert.ok(c.includes('下周:周一 2026-08-31'), '下周一=08-31')
  assert.ok(c.includes('周日 2026-09-06'), '下周日=09-06')
  assert.ok(c.includes('周四 2026-09-10'), '下下周四=09-10')
  assert.ok(c.includes('下个月 2026-09:初 09-01~09-10|中旬 09-11~09-20|下旬 09-21~09-30'), '下个月分段')
  assert.ok(c.includes('下个季度初:2026-10-01 起'), '下个季度初')
  assert.ok(c.includes('国庆 2026-10-01'), '国庆锚点')
  assert.ok(c.includes('元旦 2027-01-01'), '元旦取下一次发生')
  assert.ok(c.includes('春节 2027-02-06'), '春节锚点(2026 春节已过,取 2027)')
  console.log('1. 锚点卡断言 OK(固定 2026-08-27:下周一/大后天/下下周四/月分段/季度/节日)')
}

// ---- 2. 过期校验(确定性,对齐 golden 约定) ------------------------------------
{
  const anchor = buildTimeAnchor(ANCHOR_NOW)
  const base: TravelSlotExtraction = {
    schema_version: 'travel_slot_extraction.v1', language: 'zh',
    domains: ['requisition'], slots: { requisition: { start_date: '8.1', end_date: '8.10' } }, missing_slots: [],
  }
  const flagged = flagExpiredSlots(base, anchor)
  assert.deepEqual(flagged.missing_slots, ['requisition.start_date (date is expired)'], '8.1 在 08-27 锚点下过期')
  assert.equal((flagged.slots.requisition as { start_date?: string }).start_date, '8.1', '槽位原值逐字保留')
  assert.equal(flagged.missing_slots.length, 1, 'end_date 不重复判(只判主日期字段,对齐 golden)')
  const again = flagExpiredSlots(flagged, anchor)
  assert.equal(again.missing_slots.length, 1, '幂等不重复加')

  const future = flagExpiredSlots({ ...base, slots: { requisition: { start_date: '9.1' } } }, anchor)
  assert.equal(future.missing_slots.length, 0, '9.1 不过期')
  const relative = flagExpiredSlots({ ...base, slots: { requisition: { start_date: '本周三' } } }, anchor)
  assert.equal(relative.missing_slots.length, 0, '相对表达(本周三)永不判过期')
  const iso = flagExpiredSlots({ ...base, slots: { requisition: { start_date: '2026-08-01' } } }, anchor)
  assert.equal(iso.missing_slots.length, 1, 'ISO 绝对日期判过期')
  const zhDate = flagExpiredSlots({ ...base, slots: { requisition: { start_date: '8月5日' } } }, anchor)
  assert.equal(zhDate.missing_slots.length, 1, '中文月日判过期')
  const enDate = flagExpiredSlots({ ...base, slots: { requisition: { start_date: 'Aug-5' } } }, anchor)
  assert.equal(enDate.missing_slots.length, 0, '英文月名不判过期(逐字传递,对齐 golden time_english_date_range)')
  const flight = flagExpiredSlots(
    { ...base, domains: ['flight'], slots: { flight: { departure_date: '8.1' } } }, anchor)
  assert.deepEqual(flight.missing_slots, ['flight.departure_date (date is expired)'], 'flight 主日期字段')
  assert.equal(parseAbsoluteDate('下周一', 2026), null, 'parseAbsoluteDate 不碰相对表达')
  // language 判定归代码层(detectLanguage):全中文 zh / 全英文 en / 混排 mixed
  for (const c of dataset.cases) {
    assert.equal(detectLanguage(c.utterance), c.expected.language, `detectLanguage ${c.id}`)
  }
  console.log('2. 过期校验断言 OK(8.1 过期/9.1 不/本周三不/ISO+中文月日判/英文不判/幂等)+ detectLanguage 全题对齐')
}

// ---- 3. 评分器自测 ------------------------------------------------------------
{
  const exp = dataset.cases[0].expected
  const identical = structuredClone(exp)
  assert.equal(scoreExtraction(exp, identical).pass, true, '完全一致应 pass')
  const wrongLang = { ...structuredClone(exp), language: 'en' as const }
  assert.equal(scoreExtraction(exp, wrongLang).pass, false, 'language 不一致应 fail')
  const wrongDomain = { ...structuredClone(exp), domains: ['flight'] as never }
  assert.equal(scoreExtraction(exp, wrongDomain).pass, false, 'domains 不一致应 fail')
  const wrongSlot = structuredClone(exp)
  ;(wrongSlot.slots.requisition as { destination: string }).destination = '北京'
  const r = scoreExtraction(exp, wrongSlot)
  assert.equal(r.pass, false, '槽位值不一致应 fail')
  assert.ok(r.diffs.some(d => d.includes('slots.requisition.destination')), 'diff 带路径')
  const wrongMissing = { ...structuredClone(exp), missing_slots: ['requisition.start_date (date is expired)'] }
  assert.equal(scoreExtraction(exp, wrongMissing).pass, false, 'missing_slots 不一致应 fail')
  const extraKey = structuredClone(exp)
  ;(extraKey.slots.requisition as Record<string, unknown>)['adults'] = 2
  const rk = scoreExtraction(exp, extraKey)
  assert.equal(rk.pass, true, '多出键不 fail(非致命)')
  assert.equal(rk.warnings.length, 1, '多出键记 warning')
  console.log('3. 评分器自测 OK(pass/language/domains/槽位值/missing_slots/extra-key warning)')
}

// ---- 4. mock 回放管道(25/25 管道自测) ------------------------------------------
{
  const script: SlotScriptStep[] = dataset.cases.map(c => ({ when: c.utterance, extraction: c.expected }))
  const llm = createMockLlm(undefined, script)
  let pass = 0
  for (const c of dataset.cases) {
    const ext = await llm.extractSlots([{ role: 'user', text: c.utterance }])
    assert.ok(ext, `mock 应命中 ${c.id}`)
    const r = scoreExtraction(c.expected, ext)
    assert.ok(r.pass, `mock 回放 ${c.id} 应 pass:${r.diffs.join(';')}`)
    pass++
  }
  console.log(`4. mock 回放管道 OK(${pass}/${dataset.cases.length}——评分管道自身正确)`)
}

// ---- 5. 槽位→日期解析层(D-10 切片 A,slot-spec.ts) ------------------------------
{
  const anchor = buildTimeAnchor(ANCHOR_NOW) // 2026-08-27 周四
  const r = (expr: string) => resolveSlotDate(expr, anchor)

  // 绝对表达:ISO/点分/中文月日(kind=absolute)
  assert.equal(r('2026-09-05').date, '2026-09-05', 'ISO')
  assert.equal(r('8.20').date, '2026-08-20', '点分')
  assert.equal(r('9月5日').date, '2026-09-05', '中文月日')
  // 锚点卡词表:相对周/近邻日/月分段(kind=card)
  assert.equal(r('下周一').date, '2026-08-31', '下周一')
  assert.equal(r('本周六').date, '2026-08-29', '本周六')
  assert.equal(r('下下周四').date, '2026-09-10', '下下周四')
  assert.equal(r('明天').date, '2026-08-28', '明天')
  assert.equal(r('下个月中旬').date, '2026-09-11', '下个月中旬取首日')
  // 「+N」后缀(槽位规则 5/6 拼接约定)
  assert.equal(r('下周五+3').date, '2026-09-07', '下周五+3')
  assert.equal(r('8.20+2天').date, '2026-08-22', '8.20+2天')
  // 词表外:unresolved 逐字保留(不做开放式解析,ADR-12 边界)
  assert.equal(r('近期').kind, 'unresolved', '模糊词')
  assert.equal(r('这阵子').date, null, '模糊词不猜')
  assert.equal(r('next Monday').kind, 'unresolved', '英文相对不解析')
  assert.equal(r('next Monday').raw, 'next Monday', 'unresolved 保留原话')

  // 整张抽取解析:hotel+flight 双域 + unresolved 清单
  const ext: TravelSlotExtraction = {
    schema_version: 'travel_slot_extraction.v1',
    language: 'zh',
    domains: ['hotel', 'flight'],
    slots: {
      hotel: { action: 'search', city: '上海', check_in_date: '下周五', check_out_date: '下周五+3' },
      flight: { action: 'search', origin: '上海', destination: '杭州', departure_date: '这阵子', trip_type: 'one_way' },
    },
    missing_slots: [],
  }
  const resolved = resolveSlots(ext, anchor)
  assert.equal(resolved.hotel?.check_in_date?.date, '2026-09-04', 'hotel 入住=下周五')
  assert.equal(resolved.hotel?.check_out_date?.date, '2026-09-07', 'hotel 退房=下周五+3')
  assert.deepEqual(resolved.unresolved, [{ field: 'flight.departure_date', raw: '这阵子' }], 'unresolved 清单')

  // spec 一致性闸:spec 日期与代码换算分歧必须暴露;unresolved 不参与(不造假阳性)
  assert.equal(specDateMismatches({ segments: [{ date: '2026-09-04' }] }, resolved).length, 0, '一致则零 mismatch')
  const mm = specDateMismatches({ segments: [{ date: '2026-09-05' }] }, resolved)
  assert.equal(mm.length, 1, '分歧暴露')
  assert.equal(mm[0]?.specDate, '2026-09-05')
  assert.equal(mm[0]?.slotDate, '2026-09-04')
  const unresolvedOnly: ResolvedSlots = { unresolved: [{ field: 'flight.departure_date', raw: '近期' }] }
  assert.equal(specDateMismatches({ segments: [{ date: '2026-09-05' }] }, unresolvedOnly).length, 0, '全 unresolved 不参与比对')
  assert.equal(specDateMismatches({ segments: [] }, resolved).length, 0, 'spec 无日期不比对')

  console.log('5. 槽位→日期解析 OK(绝对/词表/+N/unresolved 边界/整张解析/spec 一致性闸)')
}

console.log('\nTIME-EVAL TESTS: 5/5 OK(确定性部分,CI 口径)')

// ---- 真模型巡检(--real,只读报告,不进 CI 红线) ----------------------------------
if (process.argv.includes('--real')) {
  try {
    for (const line of readFileSync(join('..', '.env'), 'utf-8').split('\n')) {
      const m = line.match(/^([A-Z_]+)=(.*)$/)
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim()
    }
  } catch { /* .env 可选 */ }
  const hasKey = Boolean(process.env['LLM_API_KEY'] ?? process.env['DEEPSEEK_API_KEY'])
  if (!hasKey) {
    console.log('\n--real:无 LLM_API_KEY,跳过真模型巡检(ADR-8 回退原则)')
  } else {
    const clock = () => ANCHOR_NOW // 锚点固定:golden 过期判定依赖 anchor_date
    const llm = createOpenAICompatLlm(undefined, clock)
    console.log(`\n=== 真模型巡检(${process.env['LLM_MODEL'] ?? 'MiniMax-M2'},锚点 ${dataset.anchor_date})===`)
    let pass = 0
    let p0Pass = 0
    let p0Total = 0
    for (const c of dataset.cases) {
      if (c.priority === 'P0') p0Total++
      try {
        const ext = await llm.extractSlots([{ role: 'user', text: c.utterance }])
        if (!ext) {
          console.log(`FAIL ${c.id}(${c.priority}):模型未产出合法 v1 JSON`)
          continue
        }
        const r = scoreExtraction(c.expected, ext)
        if (r.pass) {
          pass++
          if (c.priority === 'P0') p0Pass++
          console.log(`PASS ${c.id}${r.warnings.length ? `(warning: ${r.warnings.join(';')})` : ''}`)
        } else {
          console.log(`FAIL ${c.id}(${c.priority}):\n  ${r.diffs.join('\n  ')}`)
        }
      } catch (e) {
        console.log(`ERROR ${c.id}(${c.priority}):${(e as Error).message.slice(0, 120)}`)
      }
    }
    console.log(`\nREAL ACCURACY: ${pass}/${dataset.cases.length}(P0: ${p0Pass}/${p0Total})——巡检报告口径,不设红线`)
  }
}
