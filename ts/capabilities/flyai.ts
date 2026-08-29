/**
 * FlyAI 官方通道能力层(飞猪开放平台,data-sources.md §8 / RFC user-session-data-rfc.md P0):
 *
 * 链路(同构 anything.ts 的 CLI spawn 模式):
 *   gotry capabilities/flyai.ts
 *     → spawn `npx -y @fly-ai/flyai-cli search-flight|search-train --origin X --destination Y --dep-date D`
 *        | `search-hotel --dest-name X [--key-words K][--check-in-date A --check-out-date B]`
 *       → 飞猪 MCP API(实时直连官方商品库)
 *
 * 契约(与 hbcli/weather/opensky/anything 同构,L4 不变量):
 *   - 只读:8 工具全只读,交易经 jumpUrl/detailUrl 由人完成(与 WriteGate 哲学同构);
 *   - 永不抛错:网络/超时/解析失败一律降级返回 verdict='error';
 *   - 证据链:成功 [实时API:flyai@ts];失败 [实时API:flyai@error@ts];
 *   - 无 key 可用;FLYAI_API_KEY 为可选增强(env 透传)。
 */

import { spawn } from 'node:child_process'

export type FlyaiKind = 'flight' | 'train' | 'hotel'

export interface FlyaiQuery {
  kind: FlyaiKind
  /** 城市名(中文),如 上海 / 丽江——flight/train 必填 */
  origin?: string
  /** 目的地城市名(中文);flight/train=到达城市,hotel 未传 destName 时即目的地 */
  destination?: string
  /** YYYY-MM-DD——flight/train 必填(出发日) */
  depDate?: string
  /** hotel 目的地(中文,国家/省/市/区均可),缺省取 destination */
  destName?: string
  /** hotel 入住日 YYYY-MM-DD(与 checkOutDate 成对,可选;未定档期不带日期先摸底) */
  checkInDate?: string
  /** hotel 退房日 YYYY-MM-DD(与 checkInDate 成对) */
  checkOutDate?: string
  /** hotel 可选关键词(商业区/地标/酒店名) */
  keyWords?: string
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

export interface FlyaiHotelOption {
  /** 酒店名 */
  name: string
  /** 档级:舒适型 / 高档型 / 豪华型 …(上游 star) */
  star?: string
  /** 数字价(未鉴权态上游打码,恒为 0) */
  price: number
  /** 打码价格原值(如 "¥7xx"——真实价以 jumpUrl 落地页为准) */
  priceRaw?: string
  /** 评分(未鉴权常缺) */
  rate?: string
  address?: string
  /** 周边地标(上游 interestsPoi) */
  poi?: string
  /** 飞猪酒店 id(上游 shId) */
  hotelId?: string
  /** 飞猪侧预订/详情跳转(由人完成,agent 不碰) */
  jumpUrl?: string
}

export interface FlyaiResult {
  ok: boolean
  via: 'flyai' | 'flyai-error'
  evidence: string
  latencyMs: number
  verdict: 'hit' | 'miss' | 'error'
  kind: FlyaiKind
  options?: FlyaiOption[]
  hotels?: FlyaiHotelOption[]
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
  /** 机/火与酒店条目的顶层 price(未鉴权态为打码串,机/火如 "1xxx",酒店如 "¥7xx") */
  price?: string
  jumpUrl?: string
  /** 酒店条目字段(实测 2026-08-29,search-hotel 大理:data.itemList) */
  name?: string
  shId?: string
  star?: string
  rate?: string | null
  address?: string
  interestsPoi?: string
  detailUrl?: string
}

/**
 * 从 CLI stdout 中提取首个完整且含 itemList 的 JSON 对象。
 *
 * npx/CLI 偶发在业务 JSON 前后追加提示；不能从首个 `{` 一直切到 EOF。
 * 扫描器识别字符串与转义,因此 JSON 字符串里的花括号不会破坏深度计数。
 */
export function parseFlyaiItemList(stdout: string): unknown[] {
  let start = -1
  let depth = 0
  let inString = false
  let escaped = false
  let sawIncompleteObject = false

  for (let index = 0; index < stdout.length; index += 1) {
    const char = stdout[index]!
    if (start < 0) {
      if (char === '{') {
        start = index
        depth = 1
        inString = false
        escaped = false
        sawIncompleteObject = true
      }
      continue
    }

    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }

    if (char === '"') inString = true
    else if (char === '{') depth += 1
    else if (char === '}') {
      depth -= 1
      if (depth !== 0) continue

      const candidate = stdout.slice(start, index + 1)
      start = -1
      sawIncompleteObject = false
      try {
        const parsed = JSON.parse(candidate) as { data?: { itemList?: unknown } }
        if (Array.isArray(parsed.data?.itemList)) return parsed.data.itemList
      } catch {
        // 前缀日志可能包含成对花括号但不是 JSON；继续找下一个完整对象。
      }
    }
  }

  throw new Error(sawIncompleteObject
    ? 'incomplete FlyAI JSON object'
    : 'no complete FlyAI itemList JSON object')
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

const YMD = /^\d{4}-\d{2}-\d{2}$/

/** FlyAI 官方只读检索(机票/火车票/酒店) — 任何失败走降级;不抛错 */
export async function flyaiSearch(q: FlyaiQuery): Promise<FlyaiResult> {
  const started = Date.now()
  const ts = new Date().toISOString()
  const base = { kind: q.kind, latencyMs: 0 }
  const argErr = (error: string): FlyaiResult =>
    ({ ...base, ok: false, via: 'flyai-error', verdict: 'error', evidence: `[实时API:flyai@error@${ts}] bad args`, error })

  // per-kind 参数闸:机/火与酒店参数面不同,各自校验,不合法走 error 不静默容错
  let cliArgs: string[]
  if (q.kind === 'hotel') {
    const dest = (q.destName ?? q.destination ?? '').trim()
    if (!dest) return argErr('hotel 需要 to/destName(目的地中文)')
    const badPair = (q.checkInDate ? 1 : 0) !== (q.checkOutDate ? 1 : 0)
      || (q.checkInDate && q.checkOutDate && (!YMD.test(q.checkInDate) || !YMD.test(q.checkOutDate)))
    if (badPair) return argErr('checkInDate/checkOutDate 须成对且为 YYYY-MM-DD(未定档期可不带日期先摸底)')
    cliArgs = [
      'search-hotel', '--dest-name', dest,
      ...(q.checkInDate && q.checkOutDate ? ['--check-in-date', q.checkInDate, '--check-out-date', q.checkOutDate] : []),
      ...(q.keyWords ? ['--key-words', q.keyWords] : []),
    ]
  } else {
    const origin = (q.origin ?? '').trim()
    const destination = (q.destination ?? '').trim()
    if (!origin || !destination || !YMD.test(q.depDate ?? '')) {
      return argErr('origin/destination/depDate(YYYY-MM-DD) required')
    }
    const sub = q.kind === 'flight' ? 'search-flight' : 'search-train'
    cliArgs = [sub, '--origin', origin, '--destination', destination, '--dep-date', (q.depDate ?? '') as string]
  }

  const r = await sh(q.cliBin ?? 'npx', ['-y', '@fly-ai/flyai-cli', ...cliArgs], {
    timeoutMs: q.timeoutMs ?? 30_000,
  })
  const latencyMs = Date.now() - started
  if (r.error || r.code !== 0) {
    return { ...base, latencyMs, ok: false, via: 'flyai-error', verdict: 'error', evidence: `[实时API:flyai@error@${ts}] ${r.error ?? `exit ${r.code}`}`, error: r.error ?? r.stderr.replace(/\s+/g, ' ').slice(0, 200) }
  }
  let items: RawItem[]
  try {
    // main-lane 加固的扫描器:容忍 npx 前缀日志/不完整对象——data:null 语义失败
    // (issue #24)的「出发日期非法」原话经 raw stdout 片段进 error 终态,语义不丢
    items = parseFlyaiItemList(r.stdout) as RawItem[]
  } catch (e) {
    // 实测(2026-08-28):Sentinel 限流时 CLI exit=0 但 stdout 是 {"message":"SentinelBlockException..."}
    const raw = r.stdout.replace(/\s+/g, ' ').slice(0, 160)
    const reason = e instanceof Error ? e.message : String(e)
    return { ...base, latencyMs, ok: false, via: 'flyai-error', verdict: 'error', evidence: `[实时API:flyai@error@${ts}] parse failed(${reason}): ${raw}`, error: `failed to parse flyai output as JSON (${reason}): ${raw}` }
  }

  if (q.kind === 'hotel') {
    const hotels = parseHotelItems(items)
    const verdict: FlyaiResult['verdict'] = hotels.length > 0 ? 'hit' : 'miss'
    return { kind: q.kind, latencyMs, ok: true, via: 'flyai', verdict, evidence: `[实时API:flyai@${ts}] ${hotels.length}/${items.length} hotel options`, hotels }
  }
  const options = parseTransportItems(items)
  const verdict: FlyaiResult['verdict'] = options.length > 0 ? 'hit' : 'miss'
  return { kind: q.kind, latencyMs, ok: true, via: 'flyai', verdict, evidence: `[实时API:flyai@${ts}] ${options.length}/${items.length} ${q.kind} options`, options }
}

/** 机/火条目 → FlyaiOption(journeys[0].segments[0];缺航班号/时刻的条目跳过) */
function parseTransportItems(items: RawItem[]): FlyaiOption[] {
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
  return options
}

/** 酒店条目 → FlyaiHotelOption(实测 2026-08-29:price 未鉴权为打码串"¥7xx",rate 常 null) */
function parseHotelItems(items: RawItem[]): FlyaiHotelOption[] {
  const hotels: FlyaiHotelOption[] = []
  for (const it of items) {
    if (!it.name) continue
    const rawPrice = String(it.price ?? '')
    // 打码价如 "¥7xx" 绝不能截成数字 7(会伪装成真价)——仅全数字串才落 price
    const bare = rawPrice.replace(/^[¥]/, '')
    const numericPrice = Number(bare)
    hotels.push({
      name: it.name,
      star: it.star,
      price: /^\d+(\.\d+)?$/.test(bare) && numericPrice > 0 ? numericPrice : 0,
      priceRaw: rawPrice || undefined,
      rate: it.rate != null ? String(it.rate) : undefined,
      address: it.address,
      poi: it.interestsPoi,
      hotelId: it.shId,
      jumpUrl: it.detailUrl,
    })
  }
  return hotels
}