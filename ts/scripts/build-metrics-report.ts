/**
 * #138 指标面板第一切片:只读聚合呈现面 v1(ADR-11 质量层,工程面交付)。
 *
 * 聚合既有落盘侧车(不新增任何数据源)→ 单一 markdown 报告:
 *   - 事实闸 verdict 分布 + blocked 牊(<stateRoot>/gotry-state/bookable-facts.jsonl)
 *   - 通道健康 down/cooldown('ok' 恢复事件 latest-wins 超越;<stateRoot>/gotry-state/channel-health.jsonl,30 天窗,
 *     与 doctor 持久面 readLatestChannelEvents 同口径)
 *   - 事故面(<stateRoot>/gotry-state/incidents.jsonl,--days 窗,默认 7)
 *   - 桥延迟 p50/p95/max + >500ms 违约计数(<stateRoot>/gotry-state/bridge-latency.jsonl;
 *     >500ms 是架构 §11 复审节奏的触发锚点,这里给出可见性)
 *   - 账本存在性(gotry-state.db 只 stat:openDb 建连即可能写 kv,指标面不打开 SQLite)
 *   - doctor 报告存在性 + 评测三层入口指针(运行结果由 run-all-tests.sh/CI 承载,v1 不重跑评测)
 *
 * 纪律:全程只读(缺文件=空节;坏行跳过,与 incidents/fact-log 同纪律);
 *       默认写 stdout,仅 --out 指定路径时落盘;零新依赖零 LLM;
 *       工程面交付,不构成 M3 Exit 证据(#138 口径,Exit 证据归 #22)。
 *
 * 运行:npx tsx ts/scripts/build-metrics-report.ts [--state-root <dir>] [--out <file>] [--days <N>]
 */

import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'

const BRIDGE_LATENCY_BUDGET_MS = 500
const CHANNEL_WINDOW_DAYS = 30

function stateFile(stateRoot: string, name: string): string {
  const root = stateRoot === '.' ? process.cwd() : stateRoot
  return join(root, 'gotry-state', name)
}

/** 坏行跳过的 JSONL 读取(与 incidents/fact-log/channel-health 同纪律) */
function readJsonl<T>(path: string): T[] {
  if (!existsSync(path)) return []
  try {
    const rows: T[] = []
    for (const line of readFileSync(path, 'utf-8').split('\n')) {
      const t = line.trim()
      if (!t) continue
      try { rows.push(JSON.parse(t) as T) } catch { /* 单行损坏不拖垮聚合 */ }
    }
    return rows
  } catch { return [] }
}

function bounded(value: string | undefined, max = 120): string | undefined {
  if (!value) return undefined
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`
}

// ---- 事实闸 ------------------------------------------------------------------

export interface FactKindStats { total: number; verdicts: Record<string, number>; blocked: number }
export interface FactsStats { lines: number; deduped: number; byKind: Record<string, FactKindStats> }

const BLOCKED_VERDICTS = new Set(['error', 'needs-setup'])

/** 同 fact_id 取最新(与 loadFactRegistry 的 dedupe 同语义;行序后者胜) */
export function aggregateFacts(rows: readonly unknown[]): FactsStats {
  const latest = new Map<string, Record<string, unknown>>()
  let lines = 0
  for (const raw of rows) {
    const row = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
    lines += 1
    const id = typeof row.fact_id === 'string' ? row.fact_id : ''
    if (!id) continue
    latest.set(id, row)
  }
  const byKind: Record<string, FactKindStats> = {}
  for (const row of latest.values()) {
    const kind = typeof row.kind === 'string' && row.kind ? row.kind : 'unknown'
    const verdict = typeof row.verdict === 'string' && row.verdict ? row.verdict : 'n/a'
    const slot = (byKind[kind] ??= { total: 0, verdicts: {}, blocked: 0 })
    slot.total += 1
    slot.verdicts[verdict] = (slot.verdicts[verdict] ?? 0) + 1
    if (BLOCKED_VERDICTS.has(verdict)) slot.blocked += 1
  }
  return { lines, deduped: latest.size, byKind }
}

// ---- 通道健康 ----------------------------------------------------------------

export interface ChannelRow { channel: string; state: string; reason?: string; at?: string; events: number }
export interface ChannelsStats { windowDays: number; latest: ChannelRow[] }

export function aggregateChannels(
  rows: readonly unknown[],
  opts: { now?: Date; windowDays?: number } = {},
): ChannelsStats {
  const nowMs = (opts.now ?? new Date()).getTime()
  const cutoff = nowMs - (opts.windowDays ?? CHANNEL_WINDOW_DAYS) * 86_400_000
  const counts = new Map<string, number>()
  const newest = new Map<string, ChannelRow & { atMs: number }>()
  // ok 超越(外部事件接缝第 1 段):通道最新事件若为 'ok'(本地探针恢复),
  // 该通道从「当前 down/cooldown」展示面退出——down 计数(历史频率)保留。
  const lastState = new Map<string, string>()
  for (const raw of rows) {
    const row = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
    if (typeof row.channel !== 'string' || !row.channel) continue
    if (typeof row.state === 'string' && ['down', 'cooldown', 'ok'].includes(row.state)) {
      lastState.set(row.channel, row.state)
    }
  }
  for (const raw of rows) {
    const row = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
    if (typeof row.channel !== 'string' || !row.channel) continue
    if (row.state !== 'down' && row.state !== 'cooldown') continue
    if (lastState.get(row.channel) === 'ok') continue
    const at = typeof row.at === 'string' ? row.at : ''
    const atMs = Date.parse(at)
    if (Number.isFinite(atMs) && atMs < cutoff) continue
    counts.set(row.channel, (counts.get(row.channel) ?? 0) + 1)
    const atMsSafe = Number.isFinite(atMs) ? atMs : 0
    const prev = newest.get(row.channel)
    if (prev && prev.atMs >= atMsSafe) continue
    newest.set(row.channel, {
      channel: row.channel,
      state: row.state,
      reason: typeof row.reason === 'string' ? row.reason : undefined,
      at: at || undefined,
      events: 0,
      atMs: atMsSafe,
    })
  }
  const latest = [...newest.values()].map(({ atMs: _atMs, ...row }) => ({
    ...row,
    events: counts.get(row.channel) ?? 0,
  }))
  return { windowDays: opts.windowDays ?? CHANNEL_WINDOW_DAYS, latest }
}

// ---- 事故面 ------------------------------------------------------------------

export interface IncidentKindStats { count: number; lastTs?: string; lastMessage?: string }
export interface IncidentsStats { windowDays: number; totalInWindow: number; byKind: Record<string, IncidentKindStats>; topSources: Array<{ source: string; count: number }> }

export function aggregateIncidents(
  rows: readonly unknown[],
  opts: { now?: Date; windowDays?: number } = {},
): IncidentsStats {
  const nowMs = (opts.now ?? new Date()).getTime()
  const windowDays = opts.windowDays ?? 7
  const cutoff = nowMs - windowDays * 86_400_000
  const byKind: Record<string, IncidentKindStats> = {}
  const sources = new Map<string, number>()
  let total = 0
  for (const raw of rows) {
    const row = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
    const ts = typeof row.ts === 'string' ? row.ts : ''
    const atMs = Date.parse(ts)
    if (Number.isFinite(atMs) && atMs < cutoff) continue
    const kind = typeof row.kind === 'string' && row.kind ? row.kind : 'unknown'
    const slot = (byKind[kind] ??= { count: 0 })
    slot.count += 1
    if (!slot.lastTs || (Number.isFinite(atMs) && atMs > Date.parse(slot.lastTs))) {
      slot.lastTs = ts || slot.lastTs
      slot.lastMessage = bounded(typeof row.message === 'string' ? row.message : undefined)
    }
    const source = typeof row.source === 'string' && row.source ? row.source : '(unknown)'
    sources.set(source, (sources.get(source) ?? 0) + 1)
    total += 1
  }
  const topSources = [...sources.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([source, count]) => ({ source, count }))
  return { windowDays, totalInWindow: total, byKind, topSources }
}

// ---- 桥延迟 ------------------------------------------------------------------

export interface LatencyStats { count: number; p50: number; p95: number; max: number; overBudget: number; budgetMs: number; topKinds: Array<{ kind: string; count: number }> }

export function aggregateLatency(rows: readonly unknown[], opts: { now?: Date; windowDays?: number } = {}): LatencyStats {
  const nowMs = (opts.now ?? new Date()).getTime()
  const cutoff = nowMs - (opts.windowDays ?? 7) * 86_400_000
  const values: number[] = []
  const kinds = new Map<string, number>()
  for (const raw of rows) {
    const row = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
    const ts = typeof row.ts === 'string' ? row.ts : ''
    const atMs = Date.parse(ts)
    if (Number.isFinite(atMs) && atMs < cutoff) continue
    const ms = typeof row.latencyMs === 'number' ? row.latencyMs : Number.NaN
    if (!Number.isFinite(ms)) continue
    values.push(ms)
    const kind = typeof row.kind === 'string' && row.kind ? row.kind : 'unknown'
    kinds.set(kind, (kinds.get(kind) ?? 0) + 1)
  }
  const sorted = [...values].sort((a, b) => a - b)
  const pick = (q: number) => (sorted.length === 0 ? 0 : sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)])
  return {
    count: sorted.length,
    p50: pick(0.5),
    p95: pick(0.95),
    max: sorted.length === 0 ? 0 : sorted[sorted.length - 1],
    overBudget: sorted.filter((ms) => ms > BRIDGE_LATENCY_BUDGET_MS).length,
    budgetMs: BRIDGE_LATENCY_BUDGET_MS,
    topKinds: [...kinds.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([kind, count]) => ({ kind, count })),
  }
}

// ---- 存在性 ------------------------------------------------------------------

export interface PresenceStats { exists: boolean; bytes?: number; mtime?: string }

function presenceOf(path: string): PresenceStats {
  try {
    if (!existsSync(path)) return { exists: false }
    const st = statSync(path)
    return { exists: true, bytes: st.size, mtime: st.mtime.toISOString() }
  } catch { return { exists: false } }
}

// ---- 聚合与渲染 ---------------------------------------------------------------

export interface MetricsSnapshot {
  generatedAt: string
  stateRoot: string
  facts: FactsStats
  channels: ChannelsStats
  incidents: IncidentsStats
  latency: LatencyStats
  ledger: PresenceStats
  doctorReport: PresenceStats
}

export async function collectMetrics(stateRoot: string, opts: { now?: Date; days?: number } = {}): Promise<MetricsSnapshot> {
  const root = resolve(stateRoot === '.' ? process.cwd() : stateRoot)
  return {
    generatedAt: (opts.now ?? new Date()).toISOString(),
    stateRoot: root,
    facts: aggregateFacts(readJsonl(stateFile(stateRoot, 'bookable-facts.jsonl'))),
    channels: aggregateChannels(readJsonl(stateFile(stateRoot, 'channel-health.jsonl')), { now: opts.now, windowDays: CHANNEL_WINDOW_DAYS }),
    incidents: aggregateIncidents(readJsonl(stateFile(stateRoot, 'incidents.jsonl')), { now: opts.now, windowDays: opts.days ?? 7 }),
    latency: aggregateLatency(readJsonl(stateFile(stateRoot, 'bridge-latency.jsonl')), { now: opts.now, windowDays: opts.days ?? 7 }),
    ledger: presenceOf(stateFile(stateRoot, 'gotry-state.db')),
    doctorReport: presenceOf(stateFile(stateRoot, 'doctor-report.md')),
  }
}

function fmtRate(blocked: number, total: number): string {
  return total === 0 ? '—' : `${blocked}/${total}(${((blocked / total) * 100).toFixed(0)}%)`
}

function fmtBytes(bytes: number | undefined): string {
  if (bytes === undefined) return '—'
  return bytes >= 1_048_576 ? `${(bytes / 1_048_576).toFixed(1)}MB` : `${bytes}B`
}

export function renderMetricsReport(s: MetricsSnapshot): string {
  const L: string[] = []
  L.push(`# GoTry 质量指标报告(只读聚合,#138 第一切片)`)
  L.push('')
  L.push(`- 生成时间:${s.generatedAt}`)
  L.push(`- stateRoot:\`${s.stateRoot}\`(全程只读,零 SQLite 打开)`)
  L.push(`- 口径:工程面交付,不构成 M3 Exit 证据(Exit 证据归 issue #22)`)
  L.push('')

  L.push('## 事实闸 verdict 分布(bookable-facts.jsonl,同 fact_id 取最新)')
  L.push('')
  const kinds = Object.entries(s.facts.byKind)
  if (kinds.length === 0) {
    L.push('(空:无事实落盘)')
  } else {
    L.push('| kind | 去重后 | verdict 分布 | blocked(error+needs-setup) |')
    L.push('|---|---|---|---|')
    for (const [kind, st] of kinds) {
      const dist = Object.entries(st.verdicts).map(([v, n]) => `${v}:${n}`).join(' / ')
      L.push(`| ${kind} | ${st.total} | ${dist} | ${fmtRate(st.blocked, st.total)} |`)
    }
    L.push('')
    L.push(`原始行 ${s.facts.lines},去重后 ${s.facts.deduped}(重查重放幂等)。`)
  }
  L.push('')

  L.push(`## 通道健康(channel-health.jsonl,${s.channels.windowDays} 天窗;hit 即清除,此处只见当前处于 down/cooldown 的通道;'ok' 恢复事件已超越)`)
  L.push('')
  if (s.channels.latest.length === 0) {
    L.push('(空:窗口内无 down/cooldown 事件)')
  } else {
    L.push('| 通道 | 最新状态 | 原因 | 时间 | 窗口事件 |')
    L.push('|---|---|---|---|---|')
    for (const c of s.channels.latest) {
      L.push(`| ${c.channel} | ${c.state} | ${bounded(c.reason ?? '', 60) ?? '—'} | ${c.at ?? '—'} | ${c.events} |`)
    }
  }
  L.push('')

  L.push(`## 事故面(incidents.jsonl,${s.incidents.windowDays} 天窗)`)
  L.push('')
  const incidentKinds = Object.entries(s.incidents.byKind)
  if (incidentKinds.length === 0) {
    L.push('(空:窗口内无事故)')
  } else {
    L.push('| kind | 次数 | 最近一次 |')
    L.push('|---|---|---|')
    for (const [kind, st] of incidentKinds) {
      L.push(`| ${kind} | ${st.count} | ${st.lastTs ?? '—'}${st.lastMessage ? ` · ${st.lastMessage}` : ''} |`)
    }
    const src = s.incidents.topSources.map((t) => `${t.source}×${t.count}`).join(', ')
    if (src) { L.push(''); L.push(`Top 来源:${src}`) }
  }
  L.push('')

  L.push(`## 桥延迟(bridge-latency.jsonl,${s.incidents.windowDays} 天窗;预算 ${s.latency.budgetMs}ms,超限即复审锚点)`)
  L.push('')
  if (s.latency.count === 0) {
    L.push('(空:窗口内无延迟记录)')
  } else {
    const kinds = s.latency.topKinds.map((t) => `${t.kind}×${t.count}`).join(', ')
    L.push(`样本 ${s.latency.count}:p50=${s.latency.p50}ms · p95=${s.latency.p95}ms · max=${s.latency.max}ms · 超预算(>${s.latency.budgetMs}ms)= **${s.latency.overBudget}**`)
    if (kinds) L.push(`按 kind:${kinds}`)
  }
  L.push('')

  L.push('## 账本与体检报告')
  L.push('')
  L.push(`- 账本 gotry-state.db:${s.ledger.exists ? `存在(${fmtBytes(s.ledger.bytes)},更新 ${s.ledger.mtime};明细经 \`npx @danceiny/gotry state\` 查看,指标面不打开 SQLite)` : '不存在(该 stateRoot 无账本)'}`)
  L.push(`- doctor 报告 doctor-report.md:${s.doctorReport.exists ? `存在(更新 ${s.doctorReport.mtime})` : '不存在(跑 `npx @danceiny/gotry doctor` 生成)'}`)
  L.push('')
  L.push('## 评测三层入口(ADR-11;运行结果由 run-all-tests.sh / CI 承载,v1 不在此重跑)')
  L.push('')
  L.push('- 单元/合同/golden E2E:`./scripts/run-all-tests.sh`(全绿是任何提交前闸)')
  L.push('- 合同层样例:`evaluation-contract-tests.ts`;golden E2E:`benchmark-environment-bridge-e2e.ts`;typed 契约 canary:`typed-contract-canary.ts`')
  L.push('')
  return L.join('\n')
}

// ---- CLI ---------------------------------------------------------------------

export function parseArgs(argv: string[]): { stateRoot: string; out?: string; days: number } {
  let stateRoot = '.'
  let out: string | undefined
  let days = 7
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === '--state-root') stateRoot = argv[++i] ?? stateRoot
    else if (a === '--out') out = argv[++i]
    else if (a === '--days') days = Math.max(1, Number.parseInt(argv[++i] ?? '7', 10) || 7)
  }
  return { stateRoot: isAbsolute(stateRoot) ? stateRoot : resolve(stateRoot), out, days }
}

export async function main(argv: string[], injectedNow?: Date): Promise<void> {
  const { stateRoot, out, days } = parseArgs(argv)
  const now = injectedNow ?? new Date()
  const snapshot = await collectMetrics(stateRoot, { days, now })
  const markdown = renderMetricsReport(snapshot)
  if (out) {
    writeFileSync(out, markdown + '\n', 'utf-8')
    process.stdout.write(`指标报告已写 ${out}(stateRoot 只读未动)\n`)
  } else {
    process.stdout.write(markdown + '\n')
  }
}

const invokedDirectly = process.argv[1] && import.meta.url === new URL(`file://${resolve(process.argv[1])}`).href
if (invokedDirectly) await main(process.argv.slice(2))
