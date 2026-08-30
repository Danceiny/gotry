/**
 * M3 nightly 证据生产器合同测试(run-all §35,issue #22 验收⑥「nightly real-LLM 与成本质量证据可复跑」)。
 * 全确定性、零网络、零 API 花费:
 *   - 封存价表仅可审计换算(peak 保守上界),未知模型 fail-closed,usage 缺失 fail-closed;
 *   - run_key 确定性 + 记录必须过消费方 parseNightlyRun(生产器写的就是评分器读的);
 *   - 无凭证 = waiting_external_evidence,不写任何文件(issue #22 停机纪律);
 *   - --dry-run mock 全链演练可跑通且绝不落盘。
 * 真跑(花钱)不在 CI:heartbeat/founder 手动 `npx tsx scripts/nightly-evidence.ts`。
 *
 * 价表 schema 演进(issue #49):v1 (legacy DeepSeek only) / v2 (provider-aware;DeepSeek+MiniMax);
 *   本测试在 v2 形态下覆盖:DeepSeek alias、裸模型名、MiniMax 跨 provider 命中、跨 provider 守门、
 *   MiniMax flat_no_offpeak 纪律同价守门、未声明 schema_version 拒绝、unknown model fail-closed、
 *   usage 缺失 fail-closed、run_key 确定性 + 消费方 parseNightlyRun、无凭证 waiting、dry-run 零落盘。
 */

import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  buildNightlyRunRecord,
  loadPriceTable,
  loadPromptSet,
  priceRunCost,
  runNightlyEvidence,
} from './nightly-evidence.ts'
import { parseNightlyRun } from './product-metrics.ts'

let passed = 0
function ok(label: string): void {
  passed += 1
  console.log(`  ok ${label}`)
}

// ---- 1. 封存文件可加载,schema v2 + provider-aware alias/裸模型双查找(以仓库内真正随发的数据文件为夹具) ----
const priceTable = loadPriceTable('data/llm-price-table.json')
const promptSet = loadPromptSet('data/m3-nightly-prompts.json')
assert.equal(priceTable.schema_version, 'gotry_llm_price_table_v2')
assert.equal(promptSet.schema_version, 'gotry_m3_nightly_prompt_set_v1')
assert.ok(promptSet.turns.length >= 1)
assert.ok(priceTable.prices['deepseek-v4-flash'], '裸键 deepseek-v4-flash 必须可查')
assert.ok(priceTable.prices['MiniMax-M3'], '裸键 MiniMax-M3 必须可查(provider 为单一时透明)')
assert.ok(priceTable.prices['minimax:MiniMax-M3'], 'qualified 键 minimax:MiniMax-M3 必须可查')
assert.ok(priceTable.aliases['deepseek-chat'], 'deepseek-chat 必须在 aliases 表')
assert.equal(priceTable.aliases['deepseek-chat'], 'deepseek-v4-flash')
ok('v2 schema 载入 + 裸键 + qualified 键 + alias 双查找')

// ---- 2. 保守上界不变量:每个价目 hit<=miss 且 offpeak<=peak(只高不低) ----
for (const [name, entry] of Object.entries(priceTable.prices)) {
  assert.ok(entry.input_cache_hit_usd_per_1m_peak <= entry.input_cache_miss_usd_per_1m_peak, `${name} hit<=miss`)
  assert.ok(entry.output_usd_per_1m_offpeak <= entry.output_usd_per_1m_peak, `${name} offpeak<=peak`)
}
ok('价目保守上界不变量(hit<=miss, offpeak<=peak)')

// ---- 3. 换算数学:deepseek-chat -> v4-flash peak(miss 1M + 1M out = 1.76) ----
const baseUsage = {
  calls: 3,
  inputTokens: 1_000_000,
  outputTokens: 1_000_000,
  inputCacheHitTokens: 0,
  inputCacheMissTokens: 1_000_000,
  responsesMissingUsage: 0,
}
const cost = priceRunCost('deepseek-chat', baseUsage, priceTable)
assert.equal(cost, 1.76) // 0.44 + 1.32
ok('peak miss 换算 0.44+1.32=1.76(经 alias)')

const hitUsage = { ...baseUsage, inputCacheHitTokens: 1_000_000, inputCacheMissTokens: 0 }
assert.equal(priceRunCost('deepseek-chat', hitUsage, priceTable), 1.334) // 0.014+1.32
ok('peak hit 换算 0.014+1.32=1.334')

// ---- 3b. MiniMax-M3 peak 换算(issue #49 验收):miss 1M + 1M out = 3.00(0.60+2.40,ADR-11 保守上界) ----
const m3cost = priceRunCost('MiniMax-M3', baseUsage, priceTable)
assert.equal(m3cost, 3.00) // 0.60 + 2.40
ok('MiniMax-M3 peak miss 换算 0.60+2.40=3.00')

const m3hit = priceRunCost('MiniMax-M3', hitUsage, priceTable)
assert.equal(m3hit, 2.52) // 0.12+2.40
ok('MiniMax-M3 peak hit 换算 0.12+2.40=2.52')

// ---- 3c. MiniMax flat_no_offpeak 纪律:peak 与 offpeak 列同价 —— 给定用量下两种策略产出同一价格 ----
const m3prov = priceTable.prices['minimax:MiniMax-M3']
assert.equal(m3prov.input_cache_miss_usd_per_1m_peak, m3prov.input_cache_miss_usd_per_1m_offpeak, 'MiniMax-M3 flat 纪律:peak==offpeak miss')
assert.equal(m3prov.input_cache_hit_usd_per_1m_peak, m3prov.input_cache_hit_usd_per_1m_offpeak, 'MiniMax-M3 flat 纪律:peak==offpeak hit')
assert.equal(m3prov.output_usd_per_1m_peak, m3prov.output_usd_per_1m_offpeak, 'MiniMax-M3 flat 纪律:peak==offpeak output')
ok('MiniMax flat_no_offpeak 纪律同价守门')

// ---- 3d. issue #49 验收:人为改一个不存在的模型名 → 仍 fail-closed(waiting/error,不猜价) ----
assert.throws(() => priceRunCost('unknown-model-xyz', baseUsage, priceTable), /no entry for model/)
ok('未知模型名 → fail-closed')

// ---- 4. fail-closed:未知模型 / alias 悬空 / usage 缺失 / 非法 schema_version 都不许出现价格 ----
const dangling = { ...priceTable, aliases: { 'deepseek-chat': 'not-a-model' } }
assert.throws(() => priceRunCost('deepseek-chat', baseUsage, dangling), /has no entry/)
assert.throws(() => priceRunCost('deepseek-chat', { ...baseUsage, responsesMissingUsage: 1 }, priceTable), /cost unprovable/)

// 非法 schema_version 守门(写入 tmp 后用 loadPriceTable 加载应抛错)
const tmpSchemaDir = mkdtempSync(join(tmpdir(), 'nightly-bad-schema-'))
const badSchemaPath = join(tmpSchemaDir, 'bad.json')
try {
  writeFileSync(badSchemaPath, JSON.stringify({ schema_version: 'gotry_llm_price_table_v99', prices: {} }))
  assert.throws(() => loadPriceTable(badSchemaPath), /schema_version must be/)
  ok('非法 schema_version 拒绝')
} finally {
  rmSync(tmpSchemaDir, { recursive: true, force: true })
}

// 非法 provider price_strategy 守门(在 v2 表写入非法策略应抛错)
const tmpStrategyDir = mkdtempSync(join(tmpdir(), 'nightly-bad-strategy-'))
const badStrategyPath = join(tmpStrategyDir, 'bad.json')
try {
  writeFileSync(badStrategyPath, JSON.stringify({
    schema_version: 'gotry_llm_price_table_v2',
    providers: {
      bad: { family: 'x', price_strategy: 'mystery_strategy', aliases: {}, models: { 'm': { input_cache_miss_usd_per_1m_peak: 0.1, input_cache_hit_usd_per_1m_peak: 0.01, output_usd_per_1m_peak: 0.5, input_cache_miss_usd_per_1m_offpeak: 0.1, input_cache_hit_usd_per_1m_offpeak: 0.01, output_usd_per_1m_offpeak: 0.5 } } },
    },
  }))
  assert.throws(() => loadPriceTable(badStrategyPath), /price_strategy must be/)
  ok('v2 非法 price_strategy 拒绝')
} finally {
  rmSync(tmpStrategyDir, { recursive: true, force: true })
}

ok('未知模型/悬空alias/usage缺失 fail-closed')

// ---- 5. run_key 确定性 + 消费方合同 ----
const executeAt = '2026-08-29T12:00:00.000Z'
const recordInput = {
  schema_version: 'gotry_m3_nightly_run_v1' as const,
  executed_at: executeAt,
  real_llm: true,
  prompt_set_sha256: 'a'.repeat(64),
  output_sha256: 'b'.repeat(64),
  cost_usd: 0.25,
}
const rec1 = buildNightlyRunRecord(recordInput)
const rec2 = buildNightlyRunRecord({ ...recordInput })
assert.equal(rec1.run_key, rec2.run_key)
assert.match(rec1.run_key, /^hmac-sha256:[0-9a-f]{64}$/)
parseNightlyRun(JSON.parse(JSON.stringify(rec1)), 0)
const rec3 = buildNightlyRunRecord({ ...recordInput, cost_usd: 0.26 })
assert.notEqual(rec3.run_key, rec1.run_key)
ok('run_key 确定性 + 已过消费方 parseNightlyRun')

// ---- 6. 无凭证 = waiting_external_evidence,零写入(evidence root 自身也不得被创建) ----
const prevKey = process.env['LLM_API_KEY']
const prevDeepseekKey = process.env['DEEPSEEK_API_KEY']
const waitParent = mkdtempSync(join(tmpdir(), 'nightly-wait-'))
const waitRoot = join(waitParent, 'evidence', 'm3')
try {
  delete process.env['LLM_API_KEY']
  delete process.env['DEEPSEEK_API_KEY']
  const waiting = await runNightlyEvidence({ evidenceRoot: waitRoot, dryRun: false, clock: () => new Date(executeAt) })
  assert.equal(waiting.state, 'waiting_external_evidence')
  assert.equal(waiting.record, null)
  assert.ok(waiting.reason?.includes('backoff'))
  assert.equal(existsSync(waitRoot), false, 'waiting 不得创建任何证据目录')
} finally {
  if (prevKey !== undefined) process.env['LLM_API_KEY'] = prevKey
  if (prevDeepseekKey !== undefined) process.env['DEEPSEEK_API_KEY'] = prevDeepseekKey
  rmSync(waitParent, { recursive: true, force: true })
}
ok('无凭证 → waiting_external_evidence 且零写入')

// ---- 7. dry-run:mock 全链演练,记录为 real_llm=false 且绝不落盘 ----
const dryParent = mkdtempSync(join(tmpdir(), 'nightly-dry-'))
const dryRoot = join(dryParent, 'evidence', 'm3')
try {
  const dry = await runNightlyEvidence({ evidenceRoot: dryRoot, dryRun: true, clock: () => new Date(executeAt) })
  assert.equal(dry.state, 'dry_run')
  assert.equal(dry.record?.real_llm, false)
  parseNightlyRun(JSON.parse(JSON.stringify(dry.record)), 0)
  assert.equal(existsSync(dryRoot), false, 'dry-run 不得写任何证据文件')
} finally {
  rmSync(dryParent, { recursive: true, force: true })
}
ok('dry-run mock 全链演练 + real_llm=false + 零落盘')

console.log(`nightly-evidence tests: ${passed} 组断言全绿(offline,真跑不在 CI)`)