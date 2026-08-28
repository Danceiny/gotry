/**
 * 会话面 P2-2 纯函数测试:extract(a11y 兜底抽取)+ 美团适配器骨架 + 金标准 20 查询 schema。
 * 美团 live 验证挂起(匿名 403 实测,2026-08-28)——登录态就绪后由心跳轮回填 networkHint。
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { extractA11yEntries, filterSubmitEntries, nameAffinity } from '../capabilities/session/extract.ts'
import { buildMeituanEntry, extractListings, parseMeituanSearch } from '../capabilities/session/adapters/meituan-local.ts'

let pass = 0
let fail = 0
function assert(cond: boolean, label: string, detail?: unknown): void {
  if (cond) { pass += 1; console.log(`  ok - ${label}`) } else { fail += 1; console.log(`  FAIL - ${label}${detail !== undefined ? ' :: ' + String(detail) : ''}`) }
}

console.log('A. extractA11yEntries(快照形状抽取)')
const snap = `- button "搜索" [ref=s1e5]
- textbox "出发城市" [ref=s1e6]
- heading "上海到丽江机票" [level=1]
- listitem "吉祥航空 HO5577 ¥1610 起"
- generic "广告"`
const entries = extractA11yEntries(snap)
assert(entries.length === 5 && entries[0]!.role === 'button' && entries[0]!.name === '搜索', 'role+name 提取(ref 行)')
assert(entries[2]!.name === '上海到丽江机票' && entries[3]!.role === 'listitem', 'heading/listitem 归位')
const noName = extractA11yEntries('- img\n- separator')
assert(noName.every((e) => typeof e.name === 'string'), '无 name 行保留空占位不炸')
assert(extractA11yEntries('').length === 0, '空快照返空')

console.log('B. filterSubmitEntries(DOM 提交件剔除)')
const kept = filterSubmitEntries(entries, (n) => /下单|支付/.test(n))
assert(kept.length === entries.length, '无提交词:全保留')
const snap2 = extractA11yEntries('- button "立即下单" [ref=s1e9]\n- button "搜索" [ref=s2e1]')
assert(filterSubmitEntries(snap2, (n) => /下单|支付/.test(n)).length === 1, 'button 命中提交黑名单剔除,搜索保留')
assert(filterSubmitEntries(extractA11yEntries('- heading "支付说明"'), (n) => /下单|支付/.test(n)).length === 1, '非交互 role(heading)不剔除')

console.log('C. nameAffinity(自愈候选排序底座)')
assert(nameAffinity('吉祥航空 HO5577', '吉祥航空 HO5577') === 1, '全等=1')
assert(nameAffinity('上海到丽江机票', '机票') === 0.8, '包含=0.8')
assert(nameAffinity('abc', 'xyz') < 0.5, '无关串低分')

console.log('D. 美团适配器骨架(词表边界/占位合同)')
const mt = buildMeituanEntry('大理', 'minsu', '洱海')
assert(mt.ok === true && mt.url === 'https://minsu.meituan.com/dali/?q=%E6%B4%B1%E6%B5%B7', '民宿 entry URL(拼音+关键词编码)')
assert(buildMeituanEntry('乌兰巴托', 'hotel').ok === false, '词表外城市 unresolved')
assert(parseMeituanSearch('{"any":1}') .length === 0, 'XHR 解析占位:接口实测回填前恒空(miss 语义)')

console.log('E. extractListings(a11y 兜底:名称+¥价格)')
const listings = extractListings(entries)
assert(listings.length === 1 && listings[0]!.name === '吉祥航空 HO5577' && listings[0]!.price === 1610, 'listitem 抽名称+价格,截 ¥ 后缀')
assert(extractListings(extractA11yEntries('- heading "无价格标题"')).length === 0, '无价格行不产出')

console.log('F. 金标准 20 查询 schema(只增不改语义)')
const golden = JSON.parse(readFileSync(join(import.meta.dirname, '../data/session-golden-20.json'), 'utf8')) as { queries: Array<Record<string, string>> }
assert(golden.queries.length === 20, '恰 20 条')
assert(new Set(golden.queries.map((q) => q.id)).size === 20, 'id 唯一')
const ctripCities = new Set(['上海', '北京', '广州', '深圳', '成都', '昆明', '大理', '丽江', '西安', '杭州', '三亚', '厦门', '重庆', '青岛', '长沙', '武汉', '南京', '郑州', '贵阳', '桂林', '西双版纳', '香格里拉'])
assert(golden.queries.filter((q) => q.kind === 'flight').every((q) => ctripCities.has(q.from!) && ctripCities.has(q.to!)), 'flight 城市全在双适配器词表内')
assert(golden.queries.filter((q) => q.kind.startsWith('meituan') || q.kind.startsWith('flyai')).every((q) => q.id), '每条带 id')

console.log(`\nSESSION-EXTRACT: ${pass} pass, ${fail} fail`)
process.exit(fail > 0 ? 1 : 0)
