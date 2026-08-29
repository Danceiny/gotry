/**
 * FlyAI 官方通道能力层(飞猪开放平台,data-sources.md §8 / RFC user-session-data-rfc.md P0):
 *
 * 链路(同构 anything.ts 的 CLI spawn 模式):
 *   gotry capabilities/flyai.ts
 *     → spawn `npx -y @fly-ai/flyai-cli search-flight|search-train --origin X --destination Y --dep-date D`
 *       → 飞猪 MCP API(实时直连官方商品库)
 *
 * 契约(与 hbcli/weather/opensky/anything 同构,L4 不变量):
 *   - 只读:8 工具全只读,交易经 jumpUrl 由人完成(与 WriteGate 哲学同构);
 *   - 永不抛错:网络/超时/解析失败一律降级返回 verdict='error';
 *   - 证据链:成功 [实时API:flyai@ts];失败 [实时API:flyai@error@ts];
 *   - 无 key 可用;FLYAI_API_KEY 为可选增强(env 透传)。
 */

import { spawn } from 'node:child_process'

export type FlyaiKind = 'flight' | 'train'

export interface FlyaiQuery {
  kind: FlyaiKind
  /** 城市名(中文),如 上海 / 丽江 */
  origin: string
  destination: string
  /** YYYY-MM-DD */
  depDate: string
  /** 默认 30_000 ms(npx 冷启动 + 远端检索) */
  timeoutMs?: number
  /** 显式 CLI bin(默认 npx -y @fly-ai/flyai-cli) */
  cliBin?: string
}

export interface FlyaiOption {
  /** 航班号/车次,如 9C6617 / G201 */
  no: string
  /** 承运:吉祥航空 / 高铁 */
  name: string
  depDateTime: string
  arrDateTime: string
  depStation: string
  arrStation: string
  durationMin: number
  price: number
  seatClass?: string
  /** 飞猪侧预订跳转(由人完成,agent 不碰) */
  jumpUrl?: string
  /** 打码价格原值(如 "1xxx"——未鉴权态火车价被模糊化,真实价以 jumpUrl 落地页为准) */
  priceRaw?: string
}

export interface FlyaiResult {
  ok: boolean
  via: 'flyai' | 'flyai-error'
  evidence: string
  latencyMs: number
  verdict: 'hit' | 'miss' | 'error'
  kind: FlyaiKind
  options?: FlyaiOption[]
  error?: string
}

interface RawItem {
  journeys?: Array<{
    journeyType?: string
    segments?: Array<{
      marketingTransportName?: string
      marketingTransportNo?: string
      depDateTime?: string
      arrDateTime?: string
      depStationName?: string
      arrStationName?: string
      duration?: string | number
      seatClassName?: string
    }>
  }>
  ticketPrice?: string
  /** 火车条目用顶层 price(且未鉴权态为打码串如 "1xxx") */
  price?: string
  jumpUrl?: string
}

function sh(cmd: string, args: string[], opts: { timeoutMs: number }) {
  const child = spawn(cmd, args, { env: process.env, cwd: process.cwd() })
  let stdout = ''
  let stderr = ''
  let error: string | undefined
  const timer = setTimeout(() => {
    try { child.kill('SIGKILL') } catch { /* ignore */ }
  }, opts.timeoutMs)
  return new Promise<{ code: number; stdout: string; stderr: string; error?: string; timedOut?: boolean }>((resolve) => {
    child.stdout?.on('data', (d: Buffer) => { stdout += d.toString() })
    child.stderr?.on('data', (d: Buffer) => { stderr += d.toString() })
    child.on('error', (e) => { error = (e as Error).message.slice(0, 200) })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code: code ?? -1, stdout, stderr, error })
    })
  }).finally(() => clearTimeout(timer))
}

/** FlyAI 官方只读检索(机/火车票) — 任何失败走降级;不抛错 */
export async function flyaiSearch(q: FlyaiQuery): Promise<FlyaiResult> {
  const started = Date.now()
  const ts = new Date().toISOString()
  const base = { kind: q.kind, latencyMs: 0 }
  const origin = (q.origin ?? '').trim()
  const destination = (q.destination ?? '').trim()
  if (!origin || !destination || !/^\d{4}-\d{2}-\d{2}$/.test(q.depDate ?? '')) {
    return { ...base, ok: false, via: 'flyai-error', verdict: 'error', evidence: `[实时API:flyai@error@${ts}] bad args`, error: 'origin/destination/depDate(YYYY-MM-DD) required' }
  }
  const sub = q.kind === 'flight' ? 'search-flight' : 'search-train'
  const r = await sh(q.cliBin ?? 'npx', ['-y', '@fly-ai/flyai-cli', sub, '--origin', origin, '--destination', destination, '--dep-date', q.depDate], {
    timeoutMs: q.timeoutMs ?? 30_000,
  })
  const latencyMs = Date.now() - started
  if (r.error || r.code !== 0) {
    return { ...base, latencyMs, ok: false, via: 'flyai-error', verdict: 'error', evidence: `[实时API:flyai@error@${ts}] ${r.error ?? `exit ${r.code}`}`, error: r.error ?? r.stderr.replace(/\s+/g, ' ').slice(0, 200) }
  }
  let items: RawItem[]
  try {
    const jStart = r.stdout.indexOf('{')
    const parsed = JSON.parse(jStart >= 0 ? r.stdout.slice(jStart) : r.stdout) as { data?: { itemList?: RawItem[] }; message?: string }
    if (!parsed.data || parsed.data.itemList === undefined) {
      // 非业务形状(合法 JSON 但无 data.itemList):典型为 Sentinel 限流的
      // {"message":"SentinelBlockException..."}——此前被 `data?.itemList ?? []`
      // 吞成 0/0 静默 miss(issue #24)。保留原文供限流识别(含 sentinel 字样)。
      const raw = r.stdout.replace(/\s+/g, ' ').slice(0, 160)
      return { ...base, latencyMs, ok: false, via: 'flyai-error', verdict: 'error', evidence: `[实时API:flyai@error@${ts}] non-business payload: ${raw}`, error: `上游非业务响应(疑似限流):${parsed.message ?? raw}` }
    }
    items = parsed.data.itemList
  } catch {
    // 实测(2026-08-28):Sentinel 限流时 CLI exit=0 但 stdout 是 {"message":"SentinelBlockException..."}
    const raw = r.stdout.replace(/\s+/g, ' ').slice(0, 160)
    return { ...base, latencyMs, ok: false, via: 'flyai-error', verdict: 'error', evidence: `[实时API:flyai@error@${ts}] parse failed: ${raw}`, error: `failed to parse flyai output as JSON: ${raw}` }
  }
  const options: FlyaiOption[] = []
  for (const it of items) {
    const seg = it.journeys?.[0]?.segments?.[0]
    if (!seg?.marketingTransportNo || !seg.depDateTime) continue
    const rawPrice = it.ticketPrice ?? it.price ?? ''
    const numericPrice = Number(rawPrice)
    options.push({
      no: seg.marketingTransportNo,
      name: seg.marketingTransportName ?? '',
      depDateTime: seg.depDateTime ?? '',
      arrDateTime: seg.arrDateTime ?? '',
      depStation: seg.depStationName ?? '',
      arrStation: seg.arrStationName ?? '',
      durationMin: Number(seg.duration ?? 0) || 0,
      price: Number.isFinite(numericPrice) && numericPrice > 0 ? numericPrice : 0,
      priceRaw: /^\d+$/.test(rawPrice) ? undefined : rawPrice || undefined,
      seatClass: seg.seatClassName,
      jumpUrl: it.jumpUrl,
    })
  }
  const verdict: FlyaiResult['verdict'] = options.length > 0 ? 'hit' : 'miss'
  return { kind: q.kind, latencyMs, ok: true, via: 'flyai', verdict, evidence: `[实时API:flyai@${ts}] ${options.length}/${items.length} ${q.kind} options`, options }
}
