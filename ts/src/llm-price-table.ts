/**
 * The frozen LLM price table (ADR-20) and the one function that turns measured usage into dollars.
 *
 * Moved verbatim from `scripts/nightly-evidence.ts`, which re-exports it, so the nightly evidence producer, the
 * persona simulation and the AaaS quota meter all price through the same code. Prices live in
 * `data/llm-price-table.json` and change only by PR (never auto-applied). Pricing is a peak-conservative upper bound,
 * an unknown model has no price, and usage a provider omitted is unprovable: both fail closed and never guess.
 *
 * Schema evolution (issue #49): `gotry_llm_price_table_v1` is DeepSeek only, with flat fields under `prices.<model>`;
 * `gotry_llm_price_table_v2` is `providers.<id>.models.<model>`, provider-aware, and lets a provider without an
 * off-peak column fill it with the peak price. `loadPriceTable` reads both.
 */

import { readFileSync } from 'node:fs'
import type { LlmUsageTracker } from './dsh-llm.ts'

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

function round6(value: number): number {
  return Number(value.toFixed(6))
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

/** v2 reader: providers.<id>.models.<model> flattened into one aliases/prices pair, so the exposed API does not change.
 *  Lookup for a model name:
 *    1. an alias jumps to its target (qualified `providerId:model`);
 *    2. otherwise the qualified `providerId:model` key is looked up in prices;
 *    3. otherwise the bare `model` key (transparent with one provider, e.g. MiniMax-M3 is unique under minimax:models);
 *    4. still not found: fail closed. */
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

/** Dollars for one run's measured usage (peak-conservative upper bound: the table's peak columns, never a guess). */
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

/** The usage a planner invocation reports: fresh input, cache-read input and output tokens, as the gateway adapter maps them. */
export interface MeasuredLlmUsage {
  readonly inputTokens: number
  readonly outputTokens: number
  readonly cacheReadTokens?: number
}

function nonNegativeInteger(name: string, value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new RangeError(`${name} must be a non-negative integer`)
  return value
}

/** `priceRunCost` for one measured usage report. Malformed counts are rejected rather than priced. */
export function priceMeasuredUsage(model: string, usage: MeasuredLlmUsage, table: LlmPriceTable): { readonly tokens: number; readonly costUsd: number } {
  const inputTokens = nonNegativeInteger('inputTokens', usage.inputTokens)
  const outputTokens = nonNegativeInteger('outputTokens', usage.outputTokens)
  const cacheReadTokens = nonNegativeInteger('cacheReadTokens', usage.cacheReadTokens ?? 0)
  const costUsd = priceRunCost(model, {
    calls: 1,
    inputTokens: inputTokens + cacheReadTokens,
    outputTokens,
    inputCacheHitTokens: cacheReadTokens,
    inputCacheMissTokens: inputTokens,
    responsesMissingUsage: 0,
  }, table)
  return { tokens: inputTokens + cacheReadTokens + outputTokens, costUsd }
}

/** Throws unless the table prices `model`. Used at composition time so an unpriced model stops the service before any spend. */
export function assertModelPriced(model: string, table: LlmPriceTable): void {
  priceRunCost(model, { calls: 0, inputTokens: 0, outputTokens: 0, inputCacheHitTokens: 0, inputCacheMissTokens: 0, responsesMissingUsage: 0 }, table)
}
