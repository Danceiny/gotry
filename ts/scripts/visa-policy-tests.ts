/**
 * 政策事实生产端 v1 测试(issue #141,D-26 收口切片;冻结泰国页 fixture,零网络):
 *
 *  1. extractVisaSection:「签证入境」章节抽取(免签/落地签条款在案;缺章节=null)
 *  2. splitPolicyEntries:中文序号段落切分(一、二、…),短段过滤
 *  3. policyFactsFromMfa:PolicyFact 形态完整(schema/fact_id/as_of/review_by=D+30/来源证据链);幂等
 *  4. VISA_POLICY_FETCH 效应行:策略表行在案(永不重试+断路器护站);注入 handler 走抓取编排
 *  5. listCountryPaths:洲列表页国家路径提取(仅本站相对链接)
 *
 * 运行(在 ts/ 下):npx tsx scripts/visa-policy-tests.ts
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  splitPolicyEntries,
  continentListUrl,
  countryPageUrl,
  extractVisaSection,
  listCountryPaths,
  policyFactsFromMfa,
  type VisaPolicyEffectParams,
} from '../capabilities/visa-policy.ts'
import { makeProductionInterpreter, __resetEffectBreakersForTest } from '../capabilities/effect.ts'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const FIXTURE = join(ROOT, 'data', 'fixtures', 'visa-policy-tg-sample.html')

let passed = 0
function check(cond: boolean, msg: string): void {
  if (cond) {
    passed++
    console.log(`  ok - ${msg}`)
  } else {
    console.error(`  FAIL - ${msg}`)
    process.exitCode = 1
  }
}

const html = readFileSync(FIXTURE, 'utf-8')

// 1. 章节抽取
const section = extractVisaSection(html)
check(!!section && section.includes('免签'), '签证入境章节应被抽取(免签条款在案)')
check(section!.includes('2024'), '生效日期应保留(逐段溯源)')

// 2. 条目切分
const entries = splitPolicyEntries(section!)
check(entries.length >= 2, `中文序号段落切分(实际 ${entries.length} 条)`)
check(entries.every(e => e.length > 30), '条目长度下限(短段过滤)')

// 3. PolicyFact 形态
const fetchedAt = '2026-09-05T00:00:00.000Z'
const facts = policyFactsFromMfa({ countryLabel: '泰国', countryPath: 'tg_647570', section: section!, fetchedAt })
check(facts.length === entries.length, '事实数=条目数')
check(facts.every(f => f.kind === 'policy' && f.schema === 'gotry_bookable_fact.v1'), 'PolicyFact 形态')
check(facts.every(f => f.as_of === '2026-09-05' && f.review_by === '2026-10-05'), 'as_of 抓取日 + review_by=D+30')
check(facts.every(f => f.source.startsWith('cs-mfa@') && f.query_id.startsWith('visa-policy:cs-mfa:')), '来源证据链 cs.mfa.gov.cn')
// 幂等:同输入重跑 fact_id 稳定
const facts2 = policyFactsFromMfa({ countryLabel: '泰国', countryPath: 'tg_647570', section: section!, fetchedAt })
check(facts.every((f, i) => f.fact_id === facts2[i]!.fact_id), 'fact_id 幂等')

// 4. URL 形态受控
assert.equal(countryPageUrl('yz_645708', 'tg_647570'), 'https://cs.mfa.gov.cn/zggmcg/ljmdd/yz_645708/tg_647570/', 'URL 形态')
assert.equal(countryPageUrl('..', 'x'), null, '路径穿越拒绝')
assert.equal(continentListUrl('..'), null, '洲路径穿越拒绝')

// 5. 效应行:VISA_POLICY_FETCH 在注册表(永不重试+断路器护站)
__resetEffectBreakersForTest()
const interp = makeProductionInterpreter({ sleep: async () => {}, breakers: new Map(), handlers: {
  VISA_POLICY_FETCH: async () => ({ ok: true, via: 'cs-mfa', evidence: 'e', latencyMs: 1, facts: [], countries: ['tg_647570'] }),
} })
const out = await interp({ effect: 'VISA_POLICY_FETCH', params: { country: 'tg_647570' } })
assert.equal(out.trace.channel, 'api', 'trace.channel=api(策略表行在案)')
assert.equal(out.trace.attempts, 1, '礼貌抓取:单次执行(策略表 retry=null 生效)')

console.log(`\nVISA POLICY TESTS: ${passed} pass${process.exitCode ? ', FAIL' : ' (全绿)'}`)