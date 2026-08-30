/**
 * LLM 官方定价漂移监测(issue #49 长效机制)。
 *
 * 设计纪律(与 ADR-11 / issue #49 一致):
 *   - 永不自动 apply 价格变更到 llm-price-table.json——价格调整必须走 PR,
 *     由人 review;founder 2026-08-26 实测「自动 apply 容易把 down 5% 的官方新价错认为我的 bug」;
 *   - 本脚本只产出 PR-就绪的 Markdown diff,供人粘贴到 PR 描述;
 *   - 联网取数(--fetch 模式)有超时 + 离线 SKIP,默认行为零网络,适配 CI 纪律;
 *   - 解析规则保守:任何一行解析失败 → 整家 SKIP + warn,不写未知数据;
 *   - 比较口径:与 fixture 缓存的上次官方价对照——若 fixture 不存在,fetch 模式写入新 fixture,
 *     diff 模式直接报"首次运行,无 baseline"。
 *
 * 运行(在 ts/ 下):
 *   npx tsx scripts/price-drift-watch.ts              # 离线模式:对照 fixture 算 diff(零网络)
 *   npx tsx scripts/price-drift-watch.ts --fetch      # 联网模式:fetch 官方页 + 写 fixture + 算 diff
 *   npx tsx scripts/price-drift-watch.ts --format json
 *
 * 输出:stdout Markdown(默认)/JSON(--format json),心形:
 *   {
 *     schema_version: 'gotry_llm_price_drift_v1',
 *     observed_at: '<ISO>',
 *     providers: {
 *       deepseek: { status: 'unchanged' | 'drift' | 'skipped_no_baseline' | 'skipped_parse_error' | 'skipped_no_network', drift: [...] },
 *       minimax: { ... },
 *       openai:  { ... },
 *       anthropic: { ... }
 *     },
 *     suggested_pr_paragraph: '<可直接粘贴到 PR 描述的一段>'
 *   }
 *
 * 心智模型:
 *   - provider="deepseek": fixture 文件 data/llm-price-baseline-deepseek.json,
 *     上次 fetch 的官方价(rows 数组 + as_of);若不存在 → "skipped_no_baseline",
 *     提示:首次跑 --fetch 一次入 fixture。
 *   - provider="minimax": 同上,data/llm-price-baseline-minimax.json。
 *   - provider="openai": 同上,data/llm-price-baseline-openai.json。
 *   - provider="anthropic": 同上,data/llm-price-baseline-anthropic.json。
 *   - 已入价表的 provider(当前为 deepseek/minimax)才有 baseline 期望;
 *     未入价表的 provider(openai/anthropic)fetch 模式采得就当 narrative 记录,
 *     仍不进 llm-price-table.json(那是未来单独的 PR)。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export type DriftStatus = 'unchanged' | 'drift' | 'skipped_no_baseline' | 'skipped_no_snapshot' | 'skipped_parse_error' | 'skipped_no_network' | 'fetched_no_table_entry'

interface PriceRow {
  model: string
  input_cache_miss_usd_per_1m: number
  input_cache_hit_usd_per_1m: number | null
  output_usd_per_1m: number
  notes?: string
}

interface ProviderBaseline {
  schema_version: 'gotry_llm_price_baseline_v1'
  as_of: string
  source_url: string
  rows: PriceRow[]
}

export interface DriftProviderReport {
  status: DriftStatus
  source_url: string
  reason?: string
  drift?: Array<{ model: string; field: 'input_cache_miss_usd_per_1m' | 'input_cache_hit_usd_per_1m' | 'output_usd_per_1m'; from: number | null; to: number | null; direction: 'up' | 'down' | 'new' | 'removed' }>
  fetched_at?: string
}

export interface DriftReport {
  schema_version: 'gotry_llm_price_drift_v1'
  observed_at: string
  mode: 'offline' | 'fetch'
  providers: Record<string, DriftProviderReport>
  suggested_pr_paragraph: string
}

const FETCH_TIMEOUT_MS = 8000
type ProviderParser = (html: string) => PriceRow[] | null
interface ProviderSpec {
  id: string
  source_url: string
  baseline_path: string
  /** snapshot 文件路径(OpenAI/Anthropic 等 SPA 厂商专用)。snapshot 优先,保证 CI 零联网。 */
  snapshot_path?: string
  parse: ProviderParser
}
const DEFAULT_PROVIDERS: ProviderSpec[] = [
  { id: 'deepseek', source_url: 'https://api-docs.deepseek.com/quick_start/pricing', baseline_path: 'data/llm-price-baseline-deepseek.json', parse: parseDeepseekHtml },
  { id: 'minimax', source_url: 'https://platform.minimax.io/docs/guides/pricing-paygo', baseline_path: 'data/llm-price-baseline-minimax.json', parse: parseMinimaxHtml },
  { id: 'openai', source_url: 'https://openai.com/api/pricing/', baseline_path: 'data/llm-price-baseline-openai.json', snapshot_path: 'data/llm-pricing-snapshot-openai.html', parse: parseOpenaiHtml },
  { id: 'anthropic', source_url: 'https://www.anthropic.com/pricing', baseline_path: 'data/llm-price-baseline-anthropic.json', snapshot_path: 'data/llm-pricing-snapshot-anthropic.html', parse: parseAnthropicHtml },
]

async function fetchWithTimeout(url: string, timeoutMs: number): Promise<string> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { 'User-Agent': 'GoTry-price-drift-watch/1 (issue #49)' } })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return await res.text()
  } finally {
    clearTimeout(timer)
  }
}

/** DeepSeek 官方定价页是简单 HTML 表格;粗解析:美元数字 $/M token 表行。
 *  失败时不抛:返回 null,watcher 标 skipped_parse_error。 */
function parseDeepseekHtml(html: string): PriceRow[] | null {
  // DeepSeek 表格行形如:
  //   <td>deepseek-v4-flash</td><td>0.44</td><td>0.014</td><td>1.32</td>  (cache_miss/cache_hit/output per 1M)
  const rows: PriceRow[] = []
  const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/g
  const cellRe = /<td[^>]*>([\s\S]*?)<\/td>/g
  let tr: RegExpExecArray | null
  while ((tr = rowRe.exec(html)) !== null) {
    const cells: string[] = []
    let m: RegExpExecArray | null
    while ((m = cellRe.exec(tr[1])) !== null) cells.push(m[1].replace(/<[^>]+>/g, '').trim())
    if (cells.length < 4) continue
    const model = cells[0]
    if (!/^deepseek-v[34]/.test(model)) continue
    const miss = Number(cells[1])
    const hit = Number(cells[2])
    const out = Number(cells[3])
    if (!Number.isFinite(miss) || !Number.isFinite(out)) continue
    rows.push({ model, input_cache_miss_usd_per_1m: miss, input_cache_hit_usd_per_1m: Number.isFinite(hit) ? hit : null, output_usd_per_1m: out })
  }
  return rows.length > 0 ? rows : null
}

/** MiniMax Pay-as-you-go 页面是 markdown 化 HTML 文档,粗解析:model + $/M tokens 行。 */
function parseMinimaxHtml(html: string): PriceRow[] | null {
  const rows: PriceRow[] = []
  // 行形如: **MiniMax-M3** … $0.30 / M tokens (Input, ≤512k) … $1.20 / M tokens (Output, ≤512k) … $0.06 / M tokens (Cache Read)
  const lineRe = /<p[^>]*>([\s\S]*?)<\/p>/g
  let p: RegExpExecArray | null
  const seen = new Set<string>()
  while ((p = lineRe.exec(html)) !== null) {
    const text = p[1].replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim()
    const modelMatch = text.match(/(MiniMax-M2(?:\.1)?(?:-highspeed)?|MiniMax-M3)/)
    if (!modelMatch) continue
    const model = modelMatch[1]
    // 取输入/输出/缓存读取三个数;按出现顺序:Input, Output, Cache Read
    const numbers = Array.from(text.matchAll(/\$([0-9]+(?:\.[0-9]+)?)\s*\/\s*M\s*tokens?/g)).map(m => Number(m[1]))
    if (numbers.length < 2) continue
    // 输入/输出 两个必备;Cache Read 可选
    const [miss, out] = numbers
    const hit = numbers.length >= 3 ? numbers[2] : null
    if (seen.has(model)) continue
    seen.add(model)
    rows.push({ model, input_cache_miss_usd_per_1m: miss, input_cache_hit_usd_per_1m: hit, output_usd_per_1m: out })
  }
  return rows.length > 0 ? rows : null
}

/** OpenAI 公开页是 React SPA(服务端只返壳 JSON 与内嵌 <script>)。
 *  解析策略:`data/llm-pricing-snapshot-openai.html` snapshot 优先(入 git,CI 零联网);
 *  `--fetch` 模式覆盖 snapshot;解析取自 Next.js 嵌入的 `__NEXT_DATA__` JSON dump
 *  (其 `props.pageProps` 含 model price 数组),失败回退到段落文字粗解析。 */
export function parseOpenaiHtml(html: string): PriceRow[] | null {
  const fromNextData = parseOpenaiNextData(html)
  if (fromNextData) return fromNextData
  return parseOpenaiParagraphFallback(html)
}

function parseOpenaiNextData(html: string): PriceRow[] | null {
  const m = html.match(/<script[^>]*id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/)
  if (!m) return null
  try {
    const data = JSON.parse(m[1]) as { props?: { pageProps?: { models?: Array<Record<string, unknown>> } } }
    const models = data?.props?.pageProps?.models
    if (!Array.isArray(models) || models.length === 0) return null
    const rows: PriceRow[] = []
    for (const m of models) {
      const name = String(m['name'] ?? m['model'] ?? '').trim()
      if (!name) continue
      // 启发式:per-token 数字通常极小(<1),per-1M 数字通常 ≥ 0.1;前者要 ×1_000_000
      const rawMiss = Number(m['input_cost_per_token'] ?? m['input_per_million'] ?? m['input'])
      const rawOut = Number(m['output_cost_per_token'] ?? m['output_per_million'] ?? m['output'])
      const rawHit = Number(m['cached_input_cost_per_token'] ?? m['cached_input_per_million'] ?? m['cache_read'])
      if (!Number.isFinite(rawMiss) || !Number.isFinite(rawOut)) continue
      rows.push({
        model: name,
        input_cache_miss_usd_per_1m: rawMiss < 1 ? rawMiss * 1_000_000 : rawMiss,
        input_cache_hit_usd_per_1m: Number.isFinite(rawHit) ? (rawHit < 1 ? rawHit * 1_000_000 : rawHit) : null,
        output_usd_per_1m: rawOut < 1 ? rawOut * 1_000_000 : rawOut,
      })
    }
    return rows.length > 0 ? rows : null
  } catch {
    return null
  }
}

function parseOpenaiParagraphFallback(html: string): PriceRow[] | null {
  // 兜底:段落文字形如 "gpt-4o … $2.50 / 1M input … $10.00 / 1M output"
  const rows: PriceRow[] = []
  const lineRe = /<p[^>]*>([\s\S]*?)<\/p>|<li[^>]*>([\s\S]*?)<\/li>/g
  let m: RegExpExecArray | null
  while ((m = lineRe.exec(html)) !== null) {
    const text = (m[1] ?? m[2] ?? '').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim()
    const modelMatch = text.match(/(gpt-4o(?:-mini)?|gpt-4\.1(?:-mini)?|gpt-5(?:-mini)?|o[1-9](?:-mini|-pro)?)/)
    if (!modelMatch) continue
    const numbers = Array.from(text.matchAll(/\$([0-9]+(?:\.[0-9]+)?)\s*\/\s*(?:1M|M)/g)).map(x => Number(x[1]))
    if (numbers.length < 2) continue
    const [miss, out] = numbers
    rows.push({ model: modelMatch[1], input_cache_miss_usd_per_1m: miss, input_cache_hit_usd_per_1m: null, output_usd_per_1m: out })
  }
  return rows.length > 0 ? rows : null
}

/** Anthropic pricing 页同样 SPA,内嵌 `__NEXT_DATA__` 形态可能变;双路径同 OpenAI。 */
function parseAnthropicHtml(html: string): PriceRow[] | null {
  const fromNextData = parseAnthropicNextData(html)
  if (fromNextData) return fromNextData
  return parseAnthropicParagraphFallback(html)
}

function parseAnthropicNextData(html: string): PriceRow[] | null {
  const m = html.match(/<script[^>]*id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/)
  if (!m) return null
  try {
    const data = JSON.parse(m[1]) as { props?: { pageProps?: { pricing?: Array<Record<string, unknown>> } } }
    const pricing = data?.props?.pageProps?.pricing
    if (!Array.isArray(pricing) || pricing.length === 0) return null
    const rows: PriceRow[] = []
    for (const p of pricing) {
      const name = String(p['model'] ?? p['name'] ?? '').trim()
      if (!name) continue
      const miss = Number(p['input_cost_per_mtok'] ?? p['input'])
      const out = Number(p['output_cost_per_mtok'] ?? p['output'])
      const hit = Number(p['cache_read_cost_per_mtok'] ?? p['cache_read'])
      if (!Number.isFinite(miss) || !Number.isFinite(out)) continue
      rows.push({ model: name, input_cache_miss_usd_per_1m: miss, input_cache_hit_usd_per_1m: Number.isFinite(hit) ? hit : null, output_usd_per_1m: out })
    }
    return rows.length > 0 ? rows : null
  } catch {
    return null
  }
}

function parseAnthropicParagraphFallback(html: string): PriceRow[] | null {
  const rows: PriceRow[] = []
  const lineRe = /<p[^>]*>([\s\S]*?)<\/p>|<li[^>]*>([\s\S]*?)<\/li>/g
  let m: RegExpExecArray | null
  while ((m = lineRe.exec(html)) !== null) {
    const text = (m[1] ?? m[2] ?? '').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim()
    const modelMatch = text.match(/(claude-(?:opus|sonnet|haiku)-[0-9](?:\.[0-9])?(?:-[0-9]+k)?)/)
    if (!modelMatch) continue
    const numbers = Array.from(text.matchAll(/\$([0-9]+(?:\.[0-9]+)?)\s*\/\s*(?:1M|M|MT)/g)).map(x => Number(x[1]))
    if (numbers.length < 2) continue
    const [miss, out] = numbers
    rows.push({ model: modelMatch[1], input_cache_miss_usd_per_1m: miss, input_cache_hit_usd_per_1m: null, output_usd_per_1m: out })
  }
  return rows.length > 0 ? rows : null
}

function diffRows(baseline: PriceRow[], current: PriceRow[]): DriftProviderReport['drift'] {
  const baseMap = new Map(baseline.map(r => [r.model, r]))
  const currMap = new Map(current.map(r => [r.model, r]))
  const drift: NonNullable<DriftProviderReport['drift']> = []
  for (const [model, curr] of currMap) {
    const base = baseMap.get(model)
    if (!base) {
      drift.push({ model, field: 'input_cache_miss_usd_per_1m', from: null, to: curr.input_cache_miss_usd_per_1m, direction: 'new' })
      continue
    }
    if (base.input_cache_miss_usd_per_1m !== curr.input_cache_miss_usd_per_1m) {
      drift.push({ model, field: 'input_cache_miss_usd_per_1m', from: base.input_cache_miss_usd_per_1m, to: curr.input_cache_miss_usd_per_1m, direction: curr.input_cache_miss_usd_per_1m > base.input_cache_miss_usd_per_1m ? 'up' : 'down' })
    }
    if (base.input_cache_hit_usd_per_1m !== curr.input_cache_hit_usd_per_1m) {
      drift.push({ model, field: 'input_cache_hit_usd_per_1m', from: base.input_cache_hit_usd_per_1m, to: curr.input_cache_hit_usd_per_1m, direction: (curr.input_cache_hit_usd_per_1m ?? 0) > (base.input_cache_hit_usd_per_1m ?? 0) ? 'up' : 'down' })
    }
    if (base.output_usd_per_1m !== curr.output_usd_per_1m) {
      drift.push({ model, field: 'output_usd_per_1m', from: base.output_usd_per_1m, to: curr.output_usd_per_1m, direction: curr.output_usd_per_1m > base.output_usd_per_1m ? 'up' : 'down' })
    }
  }
  for (const [model, base] of baseMap) {
    if (!currMap.has(model)) {
      drift.push({ model, field: 'input_cache_miss_usd_per_1m', from: base.input_cache_miss_usd_per_1m, to: null, direction: 'removed' })
    }
  }
  return drift
}

function loadBaseline(path: string): ProviderBaseline | null {
  if (!existsSync(path)) return null
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
    if (raw['schema_version'] !== 'gotry_llm_price_baseline_v1') throw new Error(`baseline ${path} schema_version must be gotry_llm_price_baseline_v1, got ${String(raw['schema_version'])}`)
    const rows = raw['rows']
    if (!Array.isArray(rows)) throw new Error(`baseline ${path} rows must be array`)
    return raw as unknown as ProviderBaseline
  } catch (error) {
    return null
  }
}

/** 读 snapshot HTML 文件;不存在或空 → null。snapshot 由 `--fetch` 模式首次写盘(founder 手动 PR)。 */
function loadSnapshot(path: string): string | null {
  if (!existsSync(path)) return null
  try {
    const text = readFileSync(path, 'utf8')
    return text.length > 0 ? text : null
  } catch {
    return null
  }
}

function writeSnapshot(path: string, html: string): void {
  writeFileSync(path, html, 'utf8')
}

function writeBaseline(path: string, rows: PriceRow[], sourceUrl: string): void {
  const payload: ProviderBaseline = {
    schema_version: 'gotry_llm_price_baseline_v1',
    as_of: new Date().toISOString(),
    source_url: sourceUrl,
    rows,
  }
  writeFileSync(path, JSON.stringify(payload, null, 2) + '\n', 'utf8')
}

export interface DriftOptions {
  mode: 'offline' | 'fetch'
  observedAt: () => Date
  /** 注入 provider 列表(含 baseline 路径与 parser)——测试可换路径;默认 = 4 家主流 provider。 */
  providers?: typeof DEFAULT_PROVIDERS
  /** fetch 注入:测试可换 mock fetcher;默认 = 真 fetch + 8s 超时。 */
  fetcher?: (url: string) => Promise<string>
}

export async function runPriceDriftWatch(options: DriftOptions): Promise<DriftReport> {
  const observedAt = options.observedAt().toISOString()
  const providers: Record<string, DriftProviderReport> = {}
  const providerSpecs = options.providers ?? DEFAULT_PROVIDERS
  const fetcher = options.fetcher ?? ((url: string) => fetchWithTimeout(url, FETCH_TIMEOUT_MS))

  for (const spec of providerSpecs) {
    const baseline = loadBaseline(spec.baseline_path)
    const snapshot = spec.snapshot_path ? loadSnapshot(spec.snapshot_path) : null

    if (options.mode === 'offline') {
      // 离线模式两种来源:
      //   (a) 有 snapshot → 走 snapshot.html parse 出 current,与 baseline diff(零联网,CI 心形)
      //   (b) 无 snapshot → 只能报 baseline 状态(无东西可 diff,标 unchanged + 提示)
      if (!baseline) {
        providers[spec.id] = { status: 'skipped_no_baseline', source_url: spec.source_url, reason: `no baseline fixture at ${spec.baseline_path}; run --fetch once to seed` }
        continue
      }
      if (snapshot === null) {
        if (spec.snapshot_path) {
          providers[spec.id] = { status: 'skipped_no_snapshot', source_url: spec.source_url, reason: `no snapshot at ${spec.snapshot_path}; run --fetch once to seed (or: founder manually save official pricing page HTML as the snapshot)` }
        } else {
          providers[spec.id] = { status: 'unchanged', source_url: spec.source_url, reason: 'offline mode; baseline present, run --fetch to compare against current official prices' }
        }
        continue
      }
      const currentFromSnapshot = spec.parse(snapshot)
      if (!currentFromSnapshot) {
        providers[spec.id] = { status: 'skipped_parse_error', source_url: spec.source_url, reason: 'snapshot present but parser failed to extract rows; refresh snapshot or fix parser' }
        continue
      }
      const driftFromSnapshot = diffRows(baseline.rows, currentFromSnapshot) ?? []
      if (driftFromSnapshot.length === 0) {
        providers[spec.id] = { status: 'unchanged', source_url: spec.source_url, reason: 'offline; baseline == snapshot-derived current' }
      } else {
        providers[spec.id] = { status: 'drift', source_url: spec.source_url, fetched_at: observedAt, drift: driftFromSnapshot, reason: 'offline diff baseline vs snapshot' }
      }
      continue
    }

    // fetch mode
    let html: string
    try {
      html = await fetcher(spec.source_url)
    } catch (error) {
      providers[spec.id] = { status: 'skipped_no_network', source_url: spec.source_url, reason: `fetch failed: ${(error as Error).message}` }
      continue
    }
    // snapshot 写盘:OpenAI/Anthropic SPA 的真实状态在 snapshot 文件里(founder 手动 PR)
    if (spec.snapshot_path) writeSnapshot(spec.snapshot_path, html)
    const current = spec.parse(html)
    if (!current) {
      providers[spec.id] = { status: 'skipped_parse_error', source_url: spec.source_url, reason: 'parser did not extract any rows; snapshot was written anyway (manual review of fixture + parser required)' }
      continue
    }
    if (!baseline) {
      // 首次 fetch 写 fixture
      writeBaseline(spec.baseline_path, current, spec.source_url)
      providers[spec.id] = { status: 'fetched_no_table_entry', source_url: spec.source_url, fetched_at: observedAt, reason: 'first fetch; baseline fixture written; no current llm-price-table.json entry (add a PR if you want this provider in nightly-evidence cost math)' }
      continue
    }
    const drift = diffRows(baseline.rows, current) ?? []
    if (drift.length === 0) {
      providers[spec.id] = { status: 'unchanged', source_url: spec.source_url, fetched_at: observedAt }
    } else {
      providers[spec.id] = { status: 'drift', source_url: spec.source_url, fetched_at: observedAt, drift }
    }
  }

  const suggestedPrParagraph = renderSuggestedPr(providers, observedAt)
  return {
    schema_version: 'gotry_llm_price_drift_v1',
    observed_at: observedAt,
    mode: options.mode,
    providers,
    suggested_pr_paragraph: suggestedPrParagraph,
  }
}

function renderSuggestedPr(providers: Record<string, DriftProviderReport>, observedAt: string): string {
  const lines: string[] = [`## LLM 价格漂移监测(${observedAt})`]
  for (const [id, report] of Object.entries(providers)) {
    if (report.status === 'drift' && report.drift && report.drift.length > 0) {
      const driftItems = report.drift
      lines.push(`- **${id}**(${report.source_url}):${driftItems.length} 项变动`)
      for (const d of driftItems) {
        lines.push(`  - \`${d.model}\` ${d.field}: ${d.from ?? '∅'} → ${d.to ?? '∅'} (${d.direction})`)
      }
      lines.push('  - 建议:按 ADR-11 复核,人工提 PR 改 `data/llm-price-table.json`。')
    } else if (report.status === 'unchanged') {
      lines.push(`- **${id}**:无变动`)
    } else if (report.status === 'fetched_no_table_entry') {
      lines.push(`- **${id}**:首次 fetch,baseline 已写入(${report.reason ?? ''})`)
    } else {
      lines.push(`- **${id}** [${report.status}]:${report.reason ?? ''}`)
    }
  }
  lines.push('')
  lines.push('纪律:本监测只产 diff,不自动改价表;价格调整必须人工 PR,符合 ADR-11 「peak only-high-not-low」。')
  return lines.join('\n')
}

function formatMarkdown(report: DriftReport): string {
  const lines: string[] = [`# LLM 价格漂移监测(${report.observed_at},mode=${report.mode})`, '']
  for (const [id, r] of Object.entries(report.providers)) {
    lines.push(`## ${id} [${r.status}]`)
    lines.push(`source: ${r.source_url}`)
    if (r.reason) lines.push(`reason: ${r.reason}`)
    if (r.drift && r.drift.length > 0) {
      lines.push('| model | field | from | to | direction |')
      lines.push('|---|---|---|---|---|')
      for (const d of r.drift) lines.push(`| \`${d.model}\` | ${d.field} | ${d.from ?? '∅'} | ${d.to ?? '∅'} | ${d.direction} |`)
    }
    lines.push('')
  }
  lines.push('---')
  lines.push('')
  lines.push(report.suggested_pr_paragraph)
  return lines.join('\n')
}

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

async function main(): Promise<void> {
  const asJson = (arg('--format') ?? 'markdown') === 'json'
  const mode: 'offline' | 'fetch' = process.argv.includes('--fetch') ? 'fetch' : 'offline'
  mkdirSync('gotry-state', { recursive: true })
  try {
    const report = await runPriceDriftWatch({ mode, observedAt: () => new Date() })
    if (asJson) console.log(JSON.stringify(report, null, 2))
    else console.log(formatMarkdown(report))
  } catch (error) {
    const payload = { state: 'error', error: (error as Error).message }
    if (asJson) console.log(JSON.stringify(payload, null, 2))
    else console.error(`price-drift-watch error: ${(error as Error).message}`)
    process.exitCode = 1
  }
}

if (process.argv[1]?.endsWith('price-drift-watch.ts')) {
  await main()
}