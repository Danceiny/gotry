/**
 * M3 nightly real-LLM 证据生产器(issue #22 验收「nightly real-LLM 与成本质量证据可复跑」)。
 * ADR-11 巡检层的 nightly 形态:固定 prompt 集 × 真实 LLM,产出被 product-metrics.ts
 * 消费的 `gotry_m3_nightly_run_v1` 记录,追加进私有证据账本 gotry-state/evidence/m3/cohort.jsonl
 * (gitignored;绝不写真实产品状态 ts/dsh-runtime/gotry-state/)。
 *
 * 运行(在 ts/ 下):
 *   npx tsx scripts/nightly-evidence.ts                  # 真跑:需 LLM_API_KEY,追加证据记录
 *   npx tsx scripts/nightly-evidence.ts --dry-run        # mock 全链演练,绝不写证据
 *   npx tsx scripts/nightly-evidence.ts --format json    # 机器可读状态(heartbeat 消费)
 *   npx tsx scripts/nightly-evidence.ts --no-env-file    # 不读仓根 .env(等待态测试用)
 *
 * 纪律:
 *   - 无凭证 = waiting_external_evidence + backoff/no-spend:退出码 0,状态 JSON 明示,不写任何文件。
 *   - cost_usd 只能来自 dsh-llm 实测 usage × `data/llm-price-table.json` 封存价(peak 保守上界);
 *     usage 缺失/模型无价目 = fail-closed,不写记录、不猜价格;价目调整走 PR 改封存文件。
 *   - prompt_set_sha256 锚定 `data/m3-nightly-prompts.json` 内容;output_sha256 锚定本轮对话全文。
 *   - 预算闸 GOTRY_NIGHTLY_BUDGET_USD(默认 1.00 美元):超闸时记录照写(已发生的花费是事实),
 *     但退出码 3,heartbeat 应 backoff。
 *   - 写入前先过消费方 parseNightlyRun 校验——生产器自己写出的必须是评分器读得懂的记录。
 *
 * 价表 schema 演进(issue #49 落地):
 *   - `gotry_llm_price_table_v1`:仅 DeepSeek,flat 字段直接挂在 prices.<model> 下,本 loader 兼容读取。
 *   - `gotry_llm_price_table_v2`(本仓现状):providers.<id>.models.<model>,provider-aware。
 *     v2 引入 provider 别名/价格策略(tiered_peak_offpeak vs flat_no_offpeak),允许 MiniMax/等
 *     没有 off-peak 列的 provider 以同价占位填入 _offpeak 列(peak_conservative_upper_bound 纪律)。
 *   - reader 兼容 v1/v2:loadPriceTable 检测 schema_version;v1 走旧 PriceEntry 形态,v2 走
 *     ProviderEntry 形态;priceRunCost 与外暴露 API 不变。
 */

import { createHash } from 'node:crypto'
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createMockLlm } from '../src/mock-llm.ts'
import { createOpenAICompatLlm, type LlmUsageTracker } from '../src/dsh-llm.ts'
import { newState, runTurn } from '../src/loop.ts'
import { solveUnified } from '../src/unified.ts'
import { realtimeSolvePort } from '../src/realtime-pricing.ts'
import { parseNightlyRun } from './product-metrics.ts'
import type { LlmPort } from '../src/loop.ts'

export interface M3NightlyPromptSet {
  schema_version: 'gotry_m3_nightly_prompt_set_v1'
  description?: string
  turns: string[]
}

export interface NightlyCoreRecord {
  schema_version: 'gotry_m3_nightly_run_v1'
  executed_at: string
  real_llm: boolean
  prompt_set_sha256: string
  output_sha256: string
  cost_usd: number
}

export type NightlyRunRecord = NightlyCoreRecord & { run_key: string }

const SHA256 = /^[0-9a-f]{64}$/
const DEFAULT_BUDGET_USD = 1

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function sha256Of(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex')
}

function round6(value: number): number {
  return Number(value.toFixed(6))
}

export function loadPromptSet(path: string): M3NightlyPromptSet {
  const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
  if (raw['schema_version'] !== 'gotry_m3_nightly_prompt_set_v1') {
    throw new Error(`prompt set schema_version must be gotry_m3_nightly_prompt_set_v1, got: ${String(raw['schema_version'])}`)
  }
  const turns = raw['turns']
  if (!Array.isArray(turns) || turns.length === 0 || turns.some(t => typeof t !== 'string' || t.length === 0)) {
    throw new Error('prompt set turns must be a non-empty array of non-empty strings')
  }
  return { schema_version: 'gotry_m3_nightly_prompt_set_v1', description: raw['description'] as string | undefined, turns: turns as string[] }
}

export interface PriceEntry {
  input_cache_miss_usd_per_1m_peak: number
  input_cache_miss_usd_per_1m_offpeak: number
  input_cache_hit_usd_per_1m_peak: number
  input_cache_hit_usd_per_1m_offpeak: number
  output_usd_per_1m_peak: number
  output_usd_per_1m_offpeak: number
}

export interface LlmPriceTable {
  schema_version: 'gotry_llm_price_table_v1' | 'gotry_llm_price_table_v2'
  aliases: Record<string, string>
  prices: Record<string, PriceEntry>
}

function assertPriceEntry(label: string, value: unknown): PriceEntry {
  const entry = typeof value === 'object' && value !== null ? value as Record<string, unknown> : null
  if (!entry) throw new Error(`${label} must be an object`)
  for (const field of ['input_cache_miss_usd_per_1m_peak', 'input_cache_hit_usd_per_1m_peak', 'output_usd_per_1m_peak']) {
    const num = entry[field]
    if (typeof num !== 'number' || !Number.isFinite(num) || num < 0) {
      throw new Error(`${label}.${field} must be a non-negative finite number`)
    }
  }
  return value as PriceEntry
}

export function loadPriceTable(path: string): LlmPriceTable {
  const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
  const schemaVersion = raw['schema_version']
  if (schemaVersion === 'gotry_llm_price_table_v2') {
    return loadPriceTableV2(raw)
  }
  if (schemaVersion === 'gotry_llm_price_table_v1') {
    return loadPriceTableV1(raw)
  }
  throw new Error(`price table schema_version must be gotry_llm_price_table_v1 or _v2, got: ${String(schemaVersion)}`)
}

function loadPriceTableV1(raw: Record<string, unknown>): LlmPriceTable {
  const aliases = typeof raw['aliases'] === 'object' && raw['aliases'] !== null ? raw['aliases'] as Record<string, string> : {}
  for (const [from, to] of Object.entries(aliases)) {
    if (typeof to !== 'string') throw new Error(`price table alias ${from} must map to a model name`)
  }
  const prices: Record<string, PriceEntry> = {}
  for (const [name, entry] of Object.entries(typeof raw['prices'] === 'object' && raw['prices'] !== null ? raw['prices'] as Record<string, unknown> : {})) {
    prices[name] = assertPriceEntry(`price table entry ${name}`, entry)
  }
  return { schema_version: 'gotry_llm_price_table_v1', aliases, prices }
}

interface ProviderEntry {
  family: string
  price_strategy: 'tiered_peak_offpeak' | 'flat_no_offpeak' | string
  api_base?: string
  source_url?: string
  aliases: Record<string, string>
  models: Record<string, PriceEntry>
}

/** v2 reader:providers.<id>.models.<model> 平铺为统一的 aliases/prices 双表,外暴露 API 不变。
 *  lookup 规则:给定 model 名 →
 *    1. 若在 aliases 表中,跳到别名目标(qualified `providerId:model`);
 *    2. 否则直接以 qualified `providerId:model` 在 prices 中查找;
 *    3. 否则尝试裸 `model` 键(单 provider 时透明,如 MiniMax-M3 在 minimax:models 下唯一);
 *    4. 仍找不到 → fail-closed。 */
function loadPriceTableV2(raw: Record<string, unknown>): LlmPriceTable {
  const providersObj = typeof raw['providers'] === 'object' && raw['providers'] !== null ? raw['providers'] as Record<string, unknown> : null
  if (!providersObj) throw new Error('price table v2 requires providers object')
  const aliases: Record<string, string> = {}
  const prices: Record<string, PriceEntry> = {}
  for (const [providerId, rawProvider] of Object.entries(providersObj)) {
    const provider = assertProviderEntry(`price table provider ${providerId}`, rawProvider)
    for (const [aliasName, target] of Object.entries(provider.aliases)) {
      if (typeof target !== 'string') throw new Error(`provider ${providerId} alias ${aliasName} must map to a model name`)
      if (!provider.models[target]) {
        throw new Error(`provider ${providerId} alias ${aliasName} -> ${target} has no entry; update data/llm-price-table.json via PR`)
      }
      aliases[aliasName] = target
    }
    for (const [modelName, entry] of Object.entries(provider.models)) {
      const qualified = `${providerId}:${modelName}`
      const validated = assertPriceEntry(`price table provider ${providerId} model ${modelName}`, entry)
      if (prices[qualified]) throw new Error(`duplicate price table key ${qualified}`)
      prices[qualified] = validated
      if (prices[modelName]) throw new Error(`duplicate price table key ${modelName} (across providers, disambiguate via aliases or qualified lookup)`)
      prices[modelName] = validated
    }
  }
  return { schema_version: 'gotry_llm_price_table_v2', aliases, prices }
}

function assertProviderEntry(label: string, value: unknown): ProviderEntry {
  const entry = typeof value === 'object' && value !== null ? value as Record<string, unknown> : null
  if (!entry) throw new Error(`${label} must be an object`)
  const family = entry['family']
  if (typeof family !== 'string' || family.length === 0) throw new Error(`${label}.family must be a non-empty string`)
  const strategy = entry['price_strategy']
  if (strategy !== 'tiered_peak_offpeak' && strategy !== 'flat_no_offpeak') {
    throw new Error(`${label}.price_strategy must be 'tiered_peak_offpeak' or 'flat_no_offpeak', got: ${String(strategy)}`)
  }
  const aliases = typeof entry['aliases'] === 'object' && entry['aliases'] !== null ? entry['aliases'] as Record<string, string> : {}
  const models = typeof entry['models'] === 'object' && entry['models'] !== null ? entry['models'] as Record<string, PriceEntry> : {}
  return {
    family,
    price_strategy: strategy,
    api_base: typeof entry['api_base'] === 'string' ? entry['api_base'] as string : undefined,
    source_url: typeof entry['source_url'] === 'string' ? entry['source_url'] as string : undefined,
    aliases,
    models,
  }
}

/** 换算单次运行成本(peak 保守上界:全部输入按 cache miss 峰价计,只高不低)。 */
export function priceRunCost(model: string, usage: LlmUsageTracker, table: LlmPriceTable): number {
  if (usage.responsesMissingUsage > 0) {
    throw new Error(`usage provider omitted usage on ${usage.responsesMissingUsage} response(s) — cost unprovable, refusing to price (fail-closed)`)
  }
  const alias = table.aliases[model]
  if (alias && !table.prices[alias]) throw new Error(`price table alias ${model} -> ${alias} has no entry; update data/llm-price-table.json via PR`)
  const entry = table.prices[alias ?? model]
  if (!entry) throw new Error(`price table has no entry for model ${model}; update data/llm-price-table.json via PR (fail-closed, no guessed price)`)
  const cost = (usage.inputCacheMissTokens * entry.input_cache_miss_usd_per_1m_peak
    + usage.inputCacheHitTokens * entry.input_cache_hit_usd_per_1m_peak
    + usage.outputTokens * entry.output_usd_per_1m_peak) / 1_000_000
  return round6(cost)
}

/** 记录构建(确定性:同内容同 executed_at => 同 run_key)。写入前由消费方 parseNightlyRun 校验。 */
export function buildNightlyRunRecord(input: NightlyCoreRecord): NightlyRunRecord {
  const { schema_version, executed_at, real_llm, prompt_set_sha256, output_sha256, cost_usd } = input
  const core = { schema_version, executed_at, real_llm, prompt_set_sha256, output_sha256, cost_usd }
  if (!SHA256.test(prompt_set_sha256) || !SHA256.test(output_sha256)) {
    throw new Error('nightly record hashes must be lowercase SHA-256 digests')
  }
  const record: NightlyRunRecord = { ...core, run_key: `hmac-sha256:${createHash('sha256').update(canonical(core)).digest('hex')}` }
  parseNightlyRun(JSON.parse(JSON.stringify(record)), 0)
  return record
}

function activeModel(): string {
  return process.env['LLM_MODEL'] ?? process.env['DEEPSEEK_MODEL'] ?? 'MiniMax-M2'
}

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

export async function runNightlyEvidence(options: {
  evidenceRoot: string
  dryRun: boolean
  clock?: () => Date
}): Promise<{ state: 'waiting_external_evidence' | 'evidence_written' | 'dry_run'; record: NightlyRunRecord | null; reason?: string; cost_over_budget?: boolean }> {
  const clock = options.clock ?? (() => new Date())

  const llmKey = process.env['LLM_API_KEY'] ?? process.env['DEEPSEEK_API_KEY']
  if (!options.dryRun && !llmKey) {
    return { state: 'waiting_external_evidence', record: null, reason: 'no real LLM credential (LLM_API_KEY/DEEPSEEK_API_KEY); waiting & backoff & no-spend per issue #22 停机纪律' }
  }

  const promptSet = loadPromptSet('data/m3-nightly-prompts.json')
  const priceTable = loadPriceTable('data/llm-price-table.json')
  const packPath = join('..', 'data', 'flights_2026.json')
  const solvePort = realtimeSolvePort(solveUnified)

  const port: LlmPort = options.dryRun ? createMockLlm(packPath) : createOpenAICompatLlm(packPath)
  const state = newState()
  const history: Array<{ role: 'user' | 'assistant'; text: string }> = []
  for (const turn of promptSet.turns) {
    const { reply } = await runTurn(state, turn, port, [...history], solvePort as never)
    history.push({ role: 'user', text: turn }, { role: 'assistant', text: reply })
  }

  const promptSetSha = sha256Of(promptSet)
  // history 是 user/assistant 交错序列;assistant 回复落在每个 user 之后(index*2+1)
  const turnsTranscript = promptSet.turns.map((turn, index) => ({ turn_index: index, user: turn, reply: history[index * 2 + 1]?.text ?? '' }))
  const outputSha = sha256Of(turnsTranscript)

  let record: NightlyRunRecord
  if (options.dryRun) {
    record = buildNightlyRunRecord({
      schema_version: 'gotry_m3_nightly_run_v1',
      executed_at: clock().toISOString(),
      real_llm: false,
      prompt_set_sha256: promptSetSha,
      output_sha256: outputSha,
      cost_usd: 0,
    })
    return { state: 'dry_run', record, reason: 'dry-run exercises the pipeline against mock LLM; no evidence written' }
  }

  const usage = (port as LlmPort & { usage?: LlmUsageTracker }).usage
  if (!usage) throw new Error('real LLM port did not expose usage tracker (dsh-llm regression) — refusing to write cost evidence')
  if (usage.calls !== promptSet.turns.length) {
    throw new Error(`usage calls ${usage.calls} != expected turns ${promptSet.turns.length} — fail-closed, no evidence written`)
  }
  const costUsd = priceRunCost(activeModel(), usage, priceTable)
  record = buildNightlyRunRecord({
    schema_version: 'gotry_m3_nightly_run_v1',
    executed_at: clock().toISOString(),
    real_llm: true,
    prompt_set_sha256: promptSetSha,
    output_sha256: outputSha,
    cost_usd: costUsd,
  })

  mkdirSync(options.evidenceRoot, { recursive: true })
  appendFileSync(join(options.evidenceRoot, 'cohort.jsonl'), `${JSON.stringify(record)}\n`, 'utf8')

  const budget = Number(process.env['GOTRY_NIGHTLY_BUDGET_USD'] ?? DEFAULT_BUDGET_USD)
  const overBudget = Number.isFinite(budget) && budget > 0 ? costUsd > budget : false
  return { state: 'evidence_written', record, cost_over_budget: overBudget, reason: overBudget ? `cost_usd ${costUsd} exceeds GOTRY_NIGHTLY_BUDGET_USD ${budget} — backoff suggested` : undefined }
}

function output(payload: { state: string; record: NightlyRunRecord | null; reason?: string; cost_over_budget?: boolean; error?: string }, asJson: boolean): void {
  if (asJson) console.log(JSON.stringify(payload))
  else {
    console.log(`nightly-evidence state: ${payload.state}${payload.error ? ` — ${payload.error}` : ''}`)
    if (payload.record) console.log(JSON.stringify(payload.record, null, 2))
    if (payload.reason) console.log(payload.reason)
  }
}

async function main(): Promise<void> {
  // 仓根 .env(gitignored):每行 KEY=VALUE,不覆盖已有环境变量;--no-env-file 供等待态测试绕过
  if (!process.argv.includes('--no-env-file')) {
    try {
      for (const line of readFileSync(join('..', '.env'), 'utf-8').split('\n')) {
        const m = line.match(/^([A-Z_]+)=(.*)$/)
        if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim()
      }
    } catch { /* .env 可选 */ }
  }
  const asJson = (arg('--format') ?? 'markdown') === 'json'
  const evidenceRoot = arg('--evidence-root') ?? 'gotry-state/evidence/m3'
  const dryRun = process.argv.includes('--dry-run')
  try {
    const result = await runNightlyEvidence({ evidenceRoot, dryRun })
    output(result, asJson)
    if (result.cost_over_budget) process.exitCode = 3
  } catch (error) {
    output({ state: 'error', record: null, error: (error as Error).message }, asJson)
    process.exitCode = 1
  }
}

if (process.argv[1]?.endsWith('nightly-evidence.ts')) {
  await main()
}