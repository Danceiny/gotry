/**
 * FlyAI 官方通道能力层(飞猪开放平台,data-sources.md §8 / RFC P0;issue #521)。
 *
 * 完整对接官方 @fly-ai/flyai-cli 1.0.16 的 8 个公开只读命令:
 *   flight/train: search-flight / search-train
 *   hotel:        search-hotel(别名 search-hotels)
 *   poi:          search-poi
 *   keyword:      keyword-search(别名 fliggy-fast-search)
 *   ai:           ai-search
 *   marriott:     search-marriott-hotel / search-marriott-package
 *
 * 链路(CLI spawn,与 hbcli/weather 同构):
 *   gotry capabilities/flyai.ts → npx -y @fly-ai/flyai-cli <command> [opts]
 *     → 飞猪 MCP(实时直连官方商品库)
 *
 * 契约(L4 不变量):
 *   - 只读:8 命令全只读,交易经 jumpUrl/detailUrl 由人完成(WriteGate 同构);
 *   - 永不抛错:网络/超时/解析失败一律降级为结构化 verdict;
 *   - 证据链:成功 [实时API:flyai@ts];失败 [实时API:flyai@error@ts];
 *   - key 解析/endpoint 覆盖口径与官方 CLI 同源(flyai-config.ts);
 *   - 子进程资源有界:独立进程组,主进程退出后 stderr drain 最多等
 *     drainMs(默认 3s),随后杀残留后代并返回——不被持管道的后代挂死。
 *
 * 故障闭集(verdict):
 *   hit / miss / auth-error(401)/ forbidden(403)/
 *   needs-setup(匿名试用 429 Trial limit)/ rate-limited(普通 429)/
 *   timeout / error(网络/Sentinel/malformed)。
 */

import { spawn } from 'node:child_process'
import { closeSync, openSync, readFileSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveFlyaiEndpoint, resolveFlyaiKey, type FlyaiKeySource } from './flyai-config.ts'

export type FlyaiKind =
  | 'flight'
  | 'train'
  | 'hotel'
  | 'poi'
  | 'keyword'
  | 'ai'
  | 'marriott-hotel'
  | 'marriott-package'

export type FlyaiVerdict =
  | 'hit'
  | 'miss'
  | 'error'
  | 'needs-setup'
  | 'auth-error'
  | 'forbidden'
  | 'rate-limited'
  | 'timeout'
  | 'cancelled'

export interface FlyaiQuery {
  kind: FlyaiKind

  // ── flight / train ──
  /** 出发城市/机场(中文或 ID);官方唯一必填 */
  origin?: string
  destination?: string
  /** 出发日 YYYY-MM-DD */
  depDate?: string
  depDateStart?: string
  depDateEnd?: string
  /** 回程日 YYYY-MM-DD */
  backDate?: string
  /** 1=直达 2=中转 */
  journeyType?: number
  /** 舱位/坐席(逗号分隔) */
  seatClassName?: string
  /** 航班号/车次(逗号分隔) */
  transportNo?: string
  /** 中转城市(逗号分隔) */
  transferCity?: string
  depHourStart?: number
  depHourEnd?: number
  arrHourStart?: number
  arrHourEnd?: number
  /** 总时长上限(小时) */
  totalDurationHour?: number
  /** 最高价 CNY */
  maxPrice?: number
  /** 机票/火车排序 1–8;万豪套餐 price_asc/price_desc */
  sortType?: string

  // ── hotel / marriott-hotel ──
  /** 目的地(国家/省/市/区中文) */
  destName?: string
  checkInDate?: string
  checkOutDate?: string
  /** 商业区/地标/酒店名关键词 */
  keyWords?: string
  /** 周边景点名 */
  poiName?: string
  /** 酒店/民宿/客栈 */
  hotelTypes?: string
  /** distance_asc / rate_desc / price_asc / price_desc / no_rank */
  sort?: string
  /** 1–5 逗号分隔 */
  hotelStars?: string
  /** king/twin/multi 逗号分隔 */
  hotelBedTypes?: string

  // ── poi ──
  /** 景点所在城市(必填) */
  cityName?: string
  /** 景点等级 1–5 */
  poiLevel?: number
  /** 景点名关键词 */
  keyword?: string
  /** 景点类别(闭集,见 FLYAI_POI_CATEGORIES) */
  category?: string

  // ── keyword-search / ai-search ──
  query?: string

  // ── marriott-hotel only ──
  hotelBrands?: string
  hotelName?: string

  // ── 运行面 ──
  /** 默认 30_000 ms(npx 冷启动 + 远端检索) */
  timeoutMs?: number
  /** 显式 CLI bin/命令(默认 npx;测试注入假脚本) */
  cliBin?: string
  /** cliBin 之后的前缀参数(默认 ['-y','@fly-ai/flyai-cli']) */
  cliPrefixArgs?: string[]
  /** 取消信号:aborted 时不 spawn;在途 abort 杀整组进程,verdict='cancelled' */
  signal?: AbortSignal
}

export interface FlyaiOption {
  no: string
  name: string
  depDateTime: string
  arrDateTime: string
  depStation: string
  arrStation: string
  durationMin: number
  price: number
  seatClass?: string
  jumpUrl?: string
  priceRaw?: string
}

export interface FlyaiHotelOption {
  name: string
  star?: string
  price: number
  priceRaw?: string
  rate?: string
  address?: string
  poi?: string
  hotelId?: string
  jumpUrl?: string
  mainPic?: string
  score?: string
  scoreDesc?: string
  review?: string
  brandName?: string
  latitude?: string
  longitude?: string
}

export interface FlyaiPoiTicketInfo {
  price?: string | null
  priceDate?: string
  ticketName?: string
}

export interface FlyaiPoiOption {
  name: string
  poiId?: string
  mainPic?: string
  jumpUrl?: string
  address?: string
  freePoiStatus?: string
  ticketInfo?: FlyaiPoiTicketInfo
}

export interface FlyaiKeywordOption {
  title: string
  jumpUrl?: string
  picUrl?: string
  price?: string
  scoreDesc?: string
  star?: string
  tags?: string[]
}

export interface FlyaiMarriottPackageOption {
  name: string
  brandName?: string
  hotelName?: string
  cityName?: string
  price?: string
  detailUrl?: string
  mainPic?: string
  sellingPoint?: string
}

export interface FlyaiResult {
  ok: boolean
  via: 'flyai' | 'flyai-error'
  evidence: string
  latencyMs: number
  verdict: FlyaiVerdict
  /** true = 普通网络/HTTP 5xx/429 或超时，可交给 effect 层退避重试 */
  retryable?: boolean
  kind: FlyaiKind
  options?: FlyaiOption[]
  hotels?: FlyaiHotelOption[]
  pois?: FlyaiPoiOption[]
  keywords?: FlyaiKeywordOption[]
  packages?: FlyaiMarriottPackageOption[]
  /** ai-search 上游自由形状数据(原样透传,不猜成事实) */
  aiData?: unknown
  error?: string
  /** 恢复/补配指引(verdict≠hit/miss 时) */
  setup?: string
  /** 本次调用实际生效的 key 来源 */
  keySource?: FlyaiKeySource
  /** true = endpoint 被 DEBUG_FLYAI_MCP_URL 覆盖 */
  endpointDebug?: boolean
  systemMessage?: string
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
  adultPrice?: string
  ticketPrice?: string
  price?: string
  jumpUrl?: string
  // hotel
  name?: string
  shId?: string
  star?: string
  rate?: string | null
  address?: string
  interestsPoi?: string
  detailUrl?: string
  mainPic?: string
  score?: string | null
  scoreDesc?: string
  review?: string
  brandName?: string
  latitude?: string
  longitude?: string
  // poi
  id?: string | number
  freePoiStatus?: string
  ticketInfo?: unknown
  // keyword
  info?: unknown
  // marriott package
  hotelName?: string
  cityName?: string
  sellingPoint?: string
}

interface ParsedItems<T> {
  options: T[]
  malformedCount: number
}

function nonEmptyText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const text = value.trim()
  return text || undefined
}

function optionalText(value: unknown, allowNull = false): string | undefined | null {
  if (value === undefined) return undefined
  if (allowNull && value === null) return null
  return nonEmptyText(value)
}

function positiveFiniteNumber(value: unknown): number | undefined {
  const number = typeof value === 'number'
    ? value
    : typeof value === 'string' && value.trim() ? Number(value.trim()) : Number.NaN
  return Number.isFinite(number) && number > 0 ? number : undefined
}

function positiveFiniteDuration(value: unknown): number | undefined {
  if (typeof value === 'number') return positiveFiniteNumber(value)
  const text = nonEmptyText(value)
  if (!text) return undefined
  const minutes = /^(\d+(?:\.\d+)?)\s*分钟$/.exec(text)?.[1]
  return positiveFiniteNumber(minutes ?? text)
}

function parseTransportPrice(value: unknown): { price: number; priceRaw?: string } | undefined {
  const raw = nonEmptyText(value)
  if (!raw) return undefined
  const bare = raw.replace(/^¥\s*/, '')
  if (/^\d+(?:\.\d+)?$/.test(bare)) {
    const price = Number(bare)
    return Number.isFinite(price) && price > 0 ? { price } : undefined
  }
  // 未鉴权态打码 1xxx/¥7xx:保留原值,绝不猜成数字。
  if (/^\d+x+$/.test(bare)) return { price: 0, priceRaw: raw }
  return undefined
}

/**
 * 从 CLI stdout 提取首个含 data.itemList 的完整 JSON 对象。
 * 扫描器识别字符串与转义;npx 前后缀日志不影响切分。
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
        // 前缀日志里的成对花括号;继续找下一完整对象。
      }
    }
  }

  throw new Error(sawIncompleteObject
    ? 'incomplete FlyAI JSON object'
    : 'no complete FlyAI itemList JSON object')
}

/** 解析 stdout 中首个完整 JSON 对象(不限 itemList;ai-search 用) */
export function parseFlyaiJsonEnvelope(stdout: string): Record<string, unknown> {
  let start = -1
  let depth = 0
  let inString = false
  let escaped = false

  for (let index = 0; index < stdout.length; index += 1) {
    const char = stdout[index]!
    if (start < 0) {
      if (char === '{') { start = index; depth = 1; inString = false; escaped = false }
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
      if (depth === 0) {
        const candidate = stdout.slice(start, index + 1)
        try { return JSON.parse(candidate) as Record<string, unknown> } catch { start = -1; depth = 0 }
      }
    }
  }
  throw new Error('no complete FlyAI JSON envelope')
}

interface ShResult {
  code: number
  stdout: string
  stderr: string
  error?: string
  timedOut?: boolean
  drainTimedOut?: boolean
  /** 调用被 AbortSignal 取消(预先 abort=未 spawn;在途 abort=进程组被杀) */
  cancelled?: boolean
}

interface FlyaiSensitiveContext {
  key?: string
  debugEndpoint?: string
}

interface FlyaiEnvContext {
  note: { keySource: FlyaiKeySource; endpointDebug?: boolean }
  sensitive: FlyaiSensitiveContext
}

const REDACTED_FLYAI_KEY = '[已隐藏 FlyAI key]'
const REDACTED_FLYAI_ENDPOINT = '?(已隐藏 endpoint 敏感参数)'

function shellUrlToken(value: string): { token: string; suffix: string } {
  const match = /[),.;!?，。！？]+$/.exec(value)
  const suffix = match?.[0] ?? ''
  return { token: suffix ? value.slice(0, -suffix.length) : value, suffix }
}

/** 只针对实际 DEBUG endpoint 的 host 脱去 userinfo/query/fragment。 */
function redactFlyaiText(value: string, sensitive: FlyaiSensitiveContext): string {
  let output = value
  if (sensitive.key) output = output.split(sensitive.key).join(REDACTED_FLYAI_KEY)
  if (!sensitive.debugEndpoint) return output

  let debugHost: string
  try {
    debugHost = new URL(sensitive.debugEndpoint).host.toLowerCase()
  } catch {
    return output
  }

  return output.replace(/\bhttps?:\/\/[^\s"'<>]+/gi, (raw) => {
    const { token, suffix } = shellUrlToken(raw)
    try {
      const url = new URL(token)
      if (url.host.toLowerCase() !== debugHost) return raw
      const path = url.pathname || '/'
      const hasSensitivePart = Boolean(url.username || url.password || url.search || url.hash)
      return `${url.protocol}//${url.host}${path}${hasSensitivePart ? REDACTED_FLYAI_ENDPOINT : ''}${suffix}`
    } catch {
      return raw
    }
  })
}

function redactFlyaiValue(value: unknown, sensitive: FlyaiSensitiveContext): unknown {
  if (typeof value === 'string') return redactFlyaiText(value, sensitive)
  if (Array.isArray(value)) return value.map(item => redactFlyaiValue(item, sensitive))
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactFlyaiValue(item, sensitive)]))
  }
  return value
}

function safeFlyaiResult<T extends FlyaiResult>(result: T, sensitive: FlyaiSensitiveContext): T {
  return redactFlyaiValue(result, sensitive) as T
}

/**
 * 子进程 stdout 走临时文件而非管道(issue #84):管道在 CLI 异步写后
 * 立即 exit 时丢尾部(实测截断 ~7.6KB,exit=0 静默);文件无此问题。
 *
 * 资源边界(#516 关切;本文件内的有界实现,#516 是否验收归其 owner):
 *   - POSIX detached 独立进程组,超时/drain 超时杀整组;
 *   - 主进程 exit 后给后代 drainMs(默认 3000ms)释放 stderr;
 *     到点 close 仍未发生则杀组、按文件已有内容返回并标 drainTimedOut。
 */
function sh(
  cmd: string,
  args: string[],
  opts: { timeoutMs: number; env?: NodeJS.ProcessEnv; drainMs?: number; signal?: AbortSignal },
): Promise<ShResult> {
  // 预先取消:不 spawn 任何进程,不产生 stdout 临时文件。
  if (opts.signal?.aborted) {
    return Promise.resolve({ code: -1, stdout: '', stderr: '', cancelled: true })
  }

  const outFile = join(tmpdir(), `gotry-flyai-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.out`)
  const outFd = openSync(outFile, 'w')
  const child = spawn(cmd, args, {
    env: opts.env ?? process.env,
    cwd: process.cwd(),
    stdio: ['ignore', outFd, 'pipe'],
    detached: process.platform !== 'win32',
  })
  let stderr = ''
  let error: string | undefined
  let timedOut = false
  let cancelled = false
  let settled = false

  const readOut = (): string => {
    try { return readFileSync(outFile, 'utf8') } catch { return '' }
  }
  const cleanupFile = (): void => {
    try { closeSync(outFd) } catch { /* ignore */ }
    try { unlinkSync(outFile) } catch { /* ignore */ }
  }
  const killGroup = (signal: NodeJS.Signals): void => {
    if (process.platform !== 'win32' && child.pid) {
      try { process.kill(-child.pid, signal); return } catch { /* fall through */ }
    }
    try { child.kill(signal) } catch { /* ignore */ }
  }

  // 在途取消:杀整个进程组(不是只杀父 PID——wrapper 的实际子进程/后代
  // 都要覆盖);由 close 收敛为 cancelled,绝不改写成 hit/miss。
  const onAbort = (): void => {
    cancelled = true
    killGroup('SIGKILL')
  }
  opts.signal?.addEventListener('abort', onAbort, { once: true })

  return new Promise<ShResult>((resolve) => {
    let exitCode = -1
    let mainExited = false
    const timer = setTimeout(() => {
      timedOut = true
      killGroup('SIGKILL')
    }, opts.timeoutMs)
    let drainTimer: NodeJS.Timeout
    const armDrainTimer = (): void => {
      clearTimeout(drainTimer)
      drainTimer = setTimeout(() => {
        killGroup('SIGKILL')
        finish({ timedOut, drainTimedOut: true })
      }, opts.drainMs ?? 3_000)
    }

    const finish = (extra: Partial<ShResult>): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      clearTimeout(drainTimer)
      opts.signal?.removeEventListener('abort', onAbort)
      // 必须先读出 stdout 再清理:closeSync 之后文件即删除,
      // 先 cleanup 会把成功响应(含空 itemList miss)读成空串。
      const stdout = readOut()
      cleanupFile()
      resolve({
        code: exitCode, stdout, stderr,
        ...(error ? { error } : {}),
        ...(cancelled ? { cancelled: true } : {}),
        ...extra,
      })
    }

    child.stderr?.on('data', (d: Buffer) => { stderr += d.toString() })
    child.on('error', (e) => { error = (e as Error).message.slice(0, 200) })
    child.on('exit', (code) => {
      exitCode = code ?? -1
      mainExited = true
      armDrainTimer()
    })
    child.on('close', (code) => {
      exitCode = code ?? exitCode
      void mainExited
      finish({ timedOut })
    })
  })
}

const YMD = /^\d{4}-\d{2}-\d{2}$/

/** search-poi 闭集类别(官方 references,2026-09 核实) */
export const FLYAI_POI_CATEGORIES = [
  '自然风光', '山湖田园', '森林丛林', '峡谷瀑布', '沙滩海岛', '沙漠草原',
  '人文古迹', '古镇古村', '历史古迹', '园林花园', '宗教场所', '公园乐园',
  '主题乐园', '水上乐园', '影视基地', '动物园', '植物园', '海洋馆', '体育场馆',
  '演出赛事', '剧院剧场', '博物馆', '纪念馆', '展览馆', '地标建筑', '市集',
  '文创街区', '城市观光', '户外活动', '滑雪', '漂流', '冲浪', '潜水', '露营', '温泉',
] as const

const HOTEL_SORTS = ['distance_asc', 'rate_desc', 'price_asc', 'price_desc', 'no_rank']
const MARRIOTT_PACKAGE_SORTS = ['price_asc', 'price_desc']

function badArg(kind: FlyaiKind, error: string, ts: string): FlyaiResult {
  return {
    kind, ok: false, via: 'flyai-error', verdict: 'error', latencyMs: 0,
    evidence: `[实时API:flyai@error@${ts}] bad args`, error,
  }
}

function hourOk(value: number): boolean {
  return Number.isInteger(value) && value >= 0 && value <= 23
}

/** 各 kind 参数校验 → CLI args;不合法返回 error 串 */
function buildCliArgs(q: FlyaiQuery): { args?: string[]; error?: string } {
  const csv = (value?: string): string[] => value ? [value] : []
  switch (q.kind) {
    case 'flight':
    case 'train': {
      if (!(q.origin ?? '').trim()) return { error: 'origin(出发城市/机场)required' }
      for (const d of [q.depDate, q.depDateStart, q.depDateEnd, q.backDate]) {
        if (d && !YMD.test(d)) return { error: `日期需 YYYY-MM-DD,实际 ${d}` }
      }
      if (q.journeyType !== undefined && q.journeyType !== 1 && q.journeyType !== 2) {
        return { error: 'journeyType 只接受 1(直达)/2(中转)' }
      }
      for (const h of [q.depHourStart, q.depHourEnd, q.arrHourStart, q.arrHourEnd]) {
        if (h !== undefined && !hourOk(h)) return { error: '小时范围需 0–23 整数' }
      }
      if (q.maxPrice !== undefined && !(q.maxPrice > 0)) return { error: 'maxPrice 需为正数' }
      if (q.totalDurationHour !== undefined && !(q.totalDurationHour > 0)) return { error: 'totalDurationHour 需为正数' }
      const sub = q.kind === 'flight' ? 'search-flight' : 'search-train'
      return {
        args: [
          sub, '--origin', q.origin!.trim(),
          ...(q.destination?.trim() ? ['--destination', q.destination.trim()] : []),
          ...(q.depDate ? ['--dep-date', q.depDate] : []),
          ...(q.depDateStart ? ['--dep-date-start', q.depDateStart] : []),
          ...(q.depDateEnd ? ['--dep-date-end', q.depDateEnd] : []),
          ...(q.backDate ? ['--back-date', q.backDate] : []),
          ...(q.journeyType !== undefined ? ['--journey-type', String(q.journeyType)] : []),
          ...csv(q.seatClassName?.trim()).flatMap(v => ['--seat-class-name', v]),
          ...csv(q.transportNo?.trim())  .flatMap(v => ['--transport-no', v]),
          ...csv(q.transferCity?.trim())  .flatMap(v => ['--transfer-city', v]),
          ...(q.depHourStart !== undefined ? ['--dep-hour-start', String(q.depHourStart)] : []),
          ...(q.depHourEnd !== undefined ? ['--dep-hour-end', String(q.depHourEnd)] : []),
          ...(q.arrHourStart !== undefined ? ['--arr-hour-start', String(q.arrHourStart)] : []),
          ...(q.arrHourEnd !== undefined ? ['--arr-hour-end', String(q.arrHourEnd)] : []),
          ...(q.totalDurationHour !== undefined ? ['--total-duration-hour', String(q.totalDurationHour)] : []),
          ...(q.maxPrice !== undefined ? ['--max-price', String(q.maxPrice)] : []),
          ...(q.sortType?.trim() ? ['--sort-type', q.sortType.trim()] : []),
        ],
      }
    }
    case 'hotel':
    case 'marriott-hotel': {
      const dest = (q.destName ?? '').trim()
      if (!dest) return { error: 'destName(目的地 国家/省/市/区)required' }
      const badPair = (q.checkInDate ? 1 : 0) !== (q.checkOutDate ? 1 : 0)
        || (q.checkInDate && (!YMD.test(q.checkInDate) || !YMD.test(q.checkOutDate ?? '')))
      if (badPair) return { error: 'checkInDate/checkOutDate 须成对且为 YYYY-MM-DD' }
      if (q.sort && !HOTEL_SORTS.includes(q.sort)) return { error: `sort 取值:${HOTEL_SORTS.join('/')}` }
      if (q.maxPrice !== undefined && !(q.maxPrice > 0)) return { error: 'maxPrice 需为正数' }
      if (q.hotelStars && !/^[1-5](,[1-5])*$/.test(q.hotelStars)) return { error: 'hotelStars 为 1–5 逗号分隔' }
      const sub = q.kind === 'hotel' ? 'search-hotel' : 'search-marriott-hotel'
      return {
        args: [
          sub, '--dest-name', dest,
          ...(q.keyWords?.trim() ? ['--key-words', q.keyWords.trim()] : []),
          ...(q.poiName?.trim() ? ['--poi-name', q.poiName.trim()] : []),
          ...(q.hotelTypes?.trim() ? ['--hotel-types', q.hotelTypes.trim()] : []),
          ...(q.sort ? ['--sort', q.sort] : []),
          ...(q.checkInDate && q.checkOutDate ? ['--check-in-date', q.checkInDate, '--check-out-date', q.checkOutDate] : []),
          ...(q.hotelStars ? ['--hotel-stars', q.hotelStars] : []),
          ...(q.hotelBedTypes?.trim() ? ['--hotel-bed-types', q.hotelBedTypes.trim()] : []),
          ...(q.maxPrice !== undefined ? ['--max-price', String(q.maxPrice)] : []),
          ...(q.kind === 'marriott-hotel'
            ? [
                ...(q.hotelBrands?.trim() ? ['--hotel-brands', q.hotelBrands.trim()] : []),
                ...(q.hotelName?.trim() ? ['--hotel-name', q.hotelName.trim()] : []),
              ]
            : []),
        ],
      }
    }
    case 'poi': {
      if (!(q.cityName ?? '').trim()) return { error: 'cityName(景点所在城市)required' }
      if (q.poiLevel !== undefined && !(Number.isInteger(q.poiLevel) && q.poiLevel >= 1 && q.poiLevel <= 5)) {
        return { error: 'poiLevel 为 1–5 整数' }
      }
      if (q.category && !FLYAI_POI_CATEGORIES.includes(q.category as typeof FLYAI_POI_CATEGORIES[number])) {
        return { error: `category 不在官方闭集(共 ${FLYAI_POI_CATEGORIES.length} 类)` }
      }
      return {
        args: [
          'search-poi', '--city-name', q.cityName!.trim(),
          ...(q.poiLevel !== undefined ? ['--poi-level', String(q.poiLevel)] : []),
          ...(q.keyword?.trim() ? ['--keyword', q.keyword.trim()] : []),
          ...(q.category ? ['--category', q.category] : []),
        ],
      }
    }
    case 'keyword':
      if (!(q.query ?? '').trim()) return { error: 'query(关键词)required' }
      return { args: ['keyword-search', '--query', q.query!.trim()] }
    case 'ai':
      if (!(q.query ?? '').trim()) return { error: 'query(完整自然语言)required' }
      return { args: ['ai-search', '--query', q.query!.trim()] }
    case 'marriott-package': {
      if (!(q.keyword ?? '').trim()) return { error: 'keyword(省/市/品牌/酒店名/卖点 单维度)required' }
      if (q.sortType && !MARRIOTT_PACKAGE_SORTS.includes(q.sortType)) {
        return { error: `sortType 仅接受 ${MARRIOTT_PACKAGE_SORTS.join('/')}` }
      }
      return {
        args: [
          'search-marriott-package', '--keyword', q.keyword!.trim(),
          ...(q.sortType ? ['--sort-type', q.sortType] : []),
        ],
      }
    }
  }
}

const KIND_LABEL: Record<FlyaiKind, string> = {
  flight: 'flight', train: 'train', hotel: 'hotel', poi: 'poi',
  keyword: 'keyword', ai: 'ai', 'marriott-hotel': 'marriott hotel', 'marriott-package': 'marriott package',
}

/**
 * FlyAI 官方只读检索(8 命令)— 任何失败走降级;不抛错。
 */
export async function flyaiSearch(q: FlyaiQuery): Promise<FlyaiResult> {
  const started = Date.now()
  const ts = new Date().toISOString()
  const envContext = await runtimeEnvNote()
  const envNote = envContext.note
  const sensitive = envContext.sensitive
  const safe = <T extends FlyaiResult>(result: T): T => safeFlyaiResult(result, sensitive)
  const built = buildCliArgs(q)
  if (built.error) return { ...badArg(q.kind, built.error, ts), ...envNote }

  const prefix = q.cliPrefixArgs ?? ['-y', '@fly-ai/flyai-cli']
  const r = await sh(q.cliBin ?? 'npx', [...prefix, ...built.args!], {
    timeoutMs: q.timeoutMs ?? 30_000,
    signal: q.signal,
  })
  const latencyMs = Date.now() - started
  const combined = `${r.stderr}\n${r.stdout}`

  if (r.cancelled) {
    return safe({
      kind: q.kind, ...envNote, latencyMs, ok: false, via: 'flyai-error', verdict: 'cancelled',
      evidence: `[实时API:flyai@error@${ts}] cancelled by caller`,
      error: q.signal?.aborted ? '调用前已取消(未发起检索)' : '检索在途被取消(进程组已终止)',
    })
  }

  if (r.timedOut) {
    return safe({
      kind: q.kind, ...envNote, latencyMs, ok: false, via: 'flyai-error', verdict: 'timeout',
      retryable: true,
      evidence: `[实时API:flyai@error@${ts}] timeout after ${q.timeoutMs ?? 30_000}ms`,
      error: `FlyAI 调用超时(本地时限 ${q.timeoutMs ?? 30_000}ms${r.drainTimedOut ? ';stderr 后代 drain 超时' : ''})`,
      setup: '检查本机网络后稍后重试,或增大 timeoutMs;急用时改走 gotry_session_search(账号会话)。',
    })
  }

  if (r.error || r.code !== 0 || /HTTP\s*(4\d\d|5\d\d)/.test(combined)) {
    return safe(classifyUpstreamFailure(q.kind, r, latencyMs, ts, envNote))
  }

  // ai-search:data 是自由形状,不走 itemList。
  if (q.kind === 'ai') {
    let envelope: Record<string, unknown>
    try {
      envelope = parseFlyaiJsonEnvelope(r.stdout)
    } catch (e) {
      const raw = r.stdout.replace(/\s+/g, ' ').slice(0, 160)
      return safe({
        kind: q.kind, ...envNote, latencyMs, ok: false, via: 'flyai-error', verdict: 'error',
        evidence: `[实时API:flyai@error@${ts}] parse failed: ${raw}`,
        error: `failed to parse flyai ai output (${(e as Error).message}): ${raw}`,
      })
    }
    const systemMessage = nonEmptyText(envelope.systemMessage)
    if (envelope.status !== undefined && envelope.status !== 0) {
      return safe({
        kind: q.kind, ...envNote, latencyMs, ok: false, via: 'flyai-error', verdict: 'error',
        evidence: `[实时API:flyai@error@${ts}] ai status=${String(envelope.status)}`,
        error: nonEmptyText(envelope.message) ?? 'ai-search upstream failure',
        ...(systemMessage ? { systemMessage } : {}),
      })
    }
    const aiData = envelope.data
    const empty = aiData === undefined || aiData === null || aiData === ''
      || (Array.isArray(aiData) && aiData.length === 0)
    return safe(JSON.parse(JSON.stringify({
      kind: q.kind, ...envNote, latencyMs, ok: true, via: 'flyai',
      verdict: empty ? 'miss' : 'hit',
      ...(empty ? {} : { aiData }),
      ...(systemMessage ? { systemMessage } : {}),
      evidence: `[实时API:flyai@${ts}] ai-search ${empty ? 'empty' : 'data returned'}`,
    })) as FlyaiResult)
  }

  let items: unknown[]
  try {
    items = parseFlyaiItemList(r.stdout) as RawItem[]
  } catch (e) {
    const raw = r.stdout.replace(/\s+/g, ' ').slice(0, 160)
    // Sentinel 限流:exit 0,stdout 为 {"message":"SentinelBlockException…"}
    if (/Sentinel/i.test(raw)) {
      return safe({
        kind: q.kind, ...envNote, latencyMs, ok: false, via: 'flyai-error', verdict: 'error',
        retryable: false,
        evidence: `[实时API:flyai@error@${ts}] sentinel: ${raw}`,
        error: `FlyAI Sentinel 限流:${raw}`,
        setup: '平台 Sentinel 限流(恢复窗口未公开)——稍后重试,或改走 gotry_session_search(账号会话)。',
      })
    }
    const reason = (e as Error).message
    return safe({
      kind: q.kind, ...envNote, latencyMs, ok: false, via: 'flyai-error', verdict: 'error',
      retryable: false,
      evidence: `[实时API:flyai@error@${ts}] parse failed(${reason}): ${raw}`,
      error: `failed to parse flyai output (${reason}): ${raw}`,
    })
  }

  return safe(parseItemListResult(q.kind, items, latencyMs, ts, envNote, r.stdout))
}

/** 当前进程 key 来源/endpoint 覆盖(仅展示,与 spawn 实际生效同源) */
async function runtimeEnvNote(): Promise<FlyaiEnvContext> {
  try {
    const key = resolveFlyaiKey()
    const endpoint = resolveFlyaiEndpoint()
    return {
      note: { keySource: key.source, ...(endpoint.debug ? { endpointDebug: true } : {}) },
      sensitive: { ...(key.key ? { key: key.key } : {}), ...(endpoint.debug ? { debugEndpoint: endpoint.url } : {}) },
    }
  } catch {
    return { note: { keySource: 'none' }, sensitive: {} }
  }
}

/** 非 0 退出 / HTTP 4xx-5xx 文本 → 故障闭集分类 */
function classifyUpstreamFailure(
  kind: FlyaiKind,
  r: ShResult,
  latencyMs: number,
  ts: string,
  envNote: { keySource: FlyaiKeySource; endpointDebug?: boolean },
): FlyaiResult {
  const upstream = `${r.stderr}\n${r.stdout}`.replace(/\s+/g, ' ').trim()
  const tag = (verdict: FlyaiVerdict, evidence: string, extra: Partial<FlyaiResult>): FlyaiResult =>
    ({ kind, ...envNote, latencyMs, ok: false, via: 'flyai-error', verdict, evidence, ...extra })

  if (/Invalid API key|HTTP\s*401|\b401\b/.test(upstream)) {
    return tag('auth-error', `[实时API:flyai@error@${ts}] 401 invalid api key`, {
      retryable: false,
      error: `FlyAI 鉴权失败(401):${upstream.slice(0, 160)}`,
      setup: '当前 key 无效或已吊销——在本机终端运行 `gotry setup flyai` 重新设置并验证(模型无法替你输入 key);`gotry setup flyai --clear` 可清除错误 key,清除后仍可匿名试用。',
    })
  }
  if (/HTTP\s*403|\b403\b/.test(upstream)) {
    return tag('forbidden', `[实时API:flyai@error@${ts}] 403 forbidden`, {
      retryable: false,
      error: `FlyAI 拒绝访问(403):${upstream.slice(0, 160)}`,
      setup: '上游 403:核对该 key 的权限范围与控制台状态;如 endpoint 被 DEBUG_FLYAI_MCP_URL 覆盖,请确认指向。',
    })
  }
  if (/Trial limit reached/.test(upstream)) {
    return tag('needs-setup', `[实时API:flyai@error@${ts}] trial quota exhausted`, {
      retryable: false,
      error: `FlyAI 匿名试用额度已用尽:${upstream.slice(0, 160)}`,
      setup: '到 flyai.open.fliggy.com 控制台申请正式 API Key,本机运行 `gotry setup flyai` 配置并验证;本会话请勿盲重试 gotry_flyai_search,机/火/酒改走 gotry_session_search。',
    })
  }
  if (/HTTP\s*429|\b429\b/.test(upstream)) {
    return tag('rate-limited', `[实时API:flyai@error@${ts}] 429 rate limited`, {
      retryable: true,
      error: `FlyAI 普通限流(非试用达限):${upstream.slice(0, 160)}`,
      setup: '上游普通限流:稍候再查,勿高频连发;仍 429 请稍后或换 gotry_session_search。',
    })
  }
  if (/timeout|timed out|ETIMEDOUT|ECONNRESET|ECONNREFUSED|ECONNABORTED|EHOSTUNREACH|ENETUNREACH|EAI_AGAIN|socket|network|fetch failed|HTTP\s*5\d\d|\b5\d\d\b/i.test(upstream)) {
    return tag('error', `[实时API:flyai@error@${ts}] transient upstream`, {
      retryable: true,
      error: `FlyAI 瞬时网络/上游错误:${upstream.slice(0, 160)}`,
      setup: '网络抖动或上游 5xx:稍后重试;持续失败请检查本机网络或改走 gotry_session_search。',
    })
  }
  return tag('error', `[实时API:flyai@error@${ts}] ${r.error ?? `exit ${r.code}`}`, {
    retryable: false,
    error: r.error ?? upstream.slice(0, 200),
  })
}

/** itemList(非 ai 类)→ 对应 typed 结果;空=miss;含 malformed=整体 error */
function parseItemListResult(
  kind: FlyaiKind,
  items: unknown[],
  latencyMs: number,
  ts: string,
  envNote: { keySource: FlyaiKeySource; endpointDebug?: boolean },
  rawStdout: string,
): FlyaiResult {
  let parsed: ParsedItems<unknown>
  switch (kind) {
    case 'flight':
    case 'train':
      parsed = parseTransportItems(items)
      break
    case 'hotel':
      parsed = parseHotelItems(items)
      break
    case 'marriott-hotel':
      parsed = parseHotelItems(items)
      break
    case 'poi':
      parsed = parsePoiItems(items)
      break
    case 'keyword':
      parsed = parseKeywordItems(items)
      break
    case 'marriott-package':
      parsed = parsePackageItems(items)
      break
    case 'ai':
      parsed = { options: [], malformedCount: 0 }
      break
  }

  const systemMessage = (() => {
    try { return nonEmptyText((JSON.parse(rawStdout) as { systemMessage?: unknown }).systemMessage) } catch { return undefined }
  })()

  if (parsed.malformedCount > 0) {
    const label = KIND_LABEL[kind]
    return {
      kind, ...envNote, latencyMs, ok: false, via: 'flyai-error', verdict: 'error',
      retryable: false,
      evidence: `[实时API:flyai@error@${ts}] ${label} itemList malformed (${parsed.malformedCount}/${items.length} items failed typed validation)`,
      error: `FlyAI ${label} itemList malformed: ${parsed.malformedCount}/${items.length} item(s) failed typed validation`,
      ...(systemMessage ? { systemMessage } : {}),
    }
  }

  const count = parsed.options.length
  const verdict: FlyaiVerdict = count > 0 ? 'hit' : 'miss'
  const evidence = `[实时API:flyai@${ts}] ${count}/${items.length} ${KIND_LABEL[kind]} options`
  const common = { kind, ...envNote, latencyMs, ok: true, via: 'flyai' as const, verdict, evidence, ...(systemMessage ? { systemMessage } : {}) }

  switch (kind) {
    case 'flight':
    case 'train':
      return { ...common, options: parsed.options as FlyaiOption[] }
    case 'hotel':
    case 'marriott-hotel':
      return { ...common, hotels: parsed.options as FlyaiHotelOption[] }
    case 'poi':
      return { ...common, pois: parsed.options as FlyaiPoiOption[] }
    case 'keyword':
      return { ...common, keywords: parsed.options as FlyaiKeywordOption[] }
    case 'marriott-package':
      return { ...common, packages: parsed.options as FlyaiMarriottPackageOption[] }
    case 'ai':
      return { ...common }
  }
}

// ── typed parsers ───────────────────────────────────────────────────────────────

/** 机/火条目 → FlyaiOption;非空列表含任一不完整条目即整体 malformed */
function parseTransportItems(items: unknown[]): ParsedItems<FlyaiOption> {
  const options: FlyaiOption[] = []
  let malformedCount = 0
  for (const raw of items) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      malformedCount += 1
      continue
    }
    const it = raw as RawItem
    const journey = Array.isArray(it.journeys) ? it.journeys[0] : undefined
    const seg = journey && typeof journey === 'object' && !Array.isArray(journey) && Array.isArray(journey.segments)
      ? journey.segments[0]
      : undefined
    if (!seg || typeof seg !== 'object' || Array.isArray(seg)) {
      malformedCount += 1
      continue
    }
    const no = nonEmptyText(seg.marketingTransportNo)
    const name = optionalText(seg.marketingTransportName)
    const depDateTime = nonEmptyText(seg.depDateTime)
    const arrDateTime = nonEmptyText(seg.arrDateTime)
    const depStation = nonEmptyText(seg.depStationName)
    const arrStation = nonEmptyText(seg.arrStationName)
    const durationMin = positiveFiniteDuration(seg.duration)
    const rawPriceValue = it.adultPrice !== undefined
      ? it.adultPrice
      : it.ticketPrice !== undefined ? it.ticketPrice : it.price
    const parsedPrice = parseTransportPrice(rawPriceValue)
    const seatClass = optionalText(seg.seatClassName)
    const jumpUrl = optionalText(it.jumpUrl)
    if (!no || !depDateTime || !arrDateTime || !depStation || !arrStation || durationMin === undefined || !parsedPrice
      || (seg.marketingTransportName !== undefined && name === undefined)
      || (seg.seatClassName !== undefined && seatClass === undefined)
      || (it.jumpUrl !== undefined && jumpUrl === undefined)) {
      malformedCount += 1
      continue
    }
    options.push({
      no, name: name ?? '', depDateTime, arrDateTime, depStation, arrStation,
      durationMin, price: parsedPrice.price, priceRaw: parsedPrice.priceRaw,
      seatClass: seatClass ?? undefined, jumpUrl: jumpUrl ?? undefined,
    })
  }
  return { options, malformedCount }
}

function stringField(parent: RawItem, key: keyof RawItem): string | undefined | null | 'bad' {
  const value = parent[key]
  if (value === undefined) return undefined
  if (value === null) return null
  return nonEmptyText(value) ?? 'bad'
}

/** 酒店/万豪酒店条目 → FlyaiHotelOption(官方两形态字段集同构) */
function parseHotelItems(items: unknown[]): ParsedItems<FlyaiHotelOption> {
  const options: FlyaiHotelOption[] = []
  let malformedCount = 0
  for (const raw of items) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      malformedCount += 1
      continue
    }
    const it = raw as RawItem
    const name = nonEmptyText(it.name)
    const star = stringField(it, 'star')
    const rawPrice = stringField(it, 'price')
    const rate = it.rate === undefined ? undefined : it.rate === null ? null : nonEmptyText(it.rate) ?? 'bad'
    const address = stringField(it, 'address')
    const poi = stringField(it, 'interestsPoi')
    const hotelId = it.shId === undefined ? undefined : nonEmptyText(it.shId) ?? (typeof it.shId === 'number' ? String(it.shId) : 'bad')
    const jumpUrl = stringField(it, 'detailUrl')
    const mainPic = stringField(it, 'mainPic')
    const score = it.score === undefined ? undefined : it.score === null ? null : nonEmptyText(it.score) ?? 'bad'
    const scoreDesc = stringField(it, 'scoreDesc')
    const review = stringField(it, 'review')
    const brandName = stringField(it, 'brandName')
    const latitude = stringField(it, 'latitude')
    const longitude = stringField(it, 'longitude')

    const fields = [star, rawPrice, rate, address, poi, hotelId, jumpUrl, mainPic, score, scoreDesc, review, brandName, latitude, longitude]
    if (!name || fields.includes('bad')) {
      malformedCount += 1
      continue
    }
    const priceText = (rawPrice ?? '') as string
    const bare = priceText.replace(/^¥/, '')
    const numericPrice = Number(bare)
    options.push({
      name,
      star: star ?? undefined,
      price: /^\d+(\.\d+)?$/.test(bare) && numericPrice > 0 ? numericPrice : 0,
      priceRaw: priceText || undefined,
      rate: rate ?? undefined,
      address: address ?? undefined,
      poi: poi ?? undefined,
      hotelId: hotelId ?? undefined,
      jumpUrl: jumpUrl ?? undefined,
      mainPic: mainPic ?? undefined,
      score: score ?? undefined,
      scoreDesc: scoreDesc ?? undefined,
      review: review ?? undefined,
      brandName: brandName ?? undefined,
      latitude: latitude ?? undefined,
      longitude: longitude ?? undefined,
    })
  }
  return { options, malformedCount }
}

/** 景点条目 → FlyaiPoiOption */
function parsePoiItems(items: unknown[]): ParsedItems<FlyaiPoiOption> {
  const options: FlyaiPoiOption[] = []
  let malformedCount = 0
  for (const raw of items) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      malformedCount += 1
      continue
    }
    const it = raw as RawItem
    const name = nonEmptyText(it.name)
    const poiId = it.id === undefined ? undefined : nonEmptyText(it.id) ?? (typeof it.id === 'number' ? String(it.id) : 'bad')
    const mainPic = stringField(it, 'mainPic')
    const jumpUrl = stringField(it, 'jumpUrl')
    const address = stringField(it, 'address')
    const freePoiStatus = stringField(it, 'freePoiStatus')
    let ticketInfo: FlyaiPoiTicketInfo | undefined | 'bad'
    if (it.ticketInfo !== undefined) {
      if (!it.ticketInfo || typeof it.ticketInfo !== 'object' || Array.isArray(it.ticketInfo)) {
        ticketInfo = 'bad'
      } else {
        const t = it.ticketInfo as Record<string, unknown>
        const price = t.price === undefined ? undefined : t.price === null ? null : nonEmptyText(t.price) ?? 'bad'
        const priceDate = t.priceDate === undefined ? undefined : nonEmptyText(t.priceDate) ?? 'bad'
        const ticketName = t.ticketName === undefined ? undefined : nonEmptyText(t.ticketName) ?? 'bad'
        if ([price, priceDate, ticketName].includes('bad')) ticketInfo = 'bad'
        else ticketInfo = { price: price ?? undefined, priceDate, ticketName }
      }
    }

    if (!name || poiId === 'bad' || [mainPic, jumpUrl, address, freePoiStatus].includes('bad') || ticketInfo === 'bad') {
      malformedCount += 1
      continue
    }
    options.push({
      name,
      poiId: poiId ?? undefined,
      mainPic: mainPic ?? undefined,
      jumpUrl: jumpUrl ?? undefined,
      address: address ?? undefined,
      freePoiStatus: freePoiStatus ?? undefined,
      ...(ticketInfo ? { ticketInfo } : {}),
    })
  }
  return { options, malformedCount }
}

/** 关键词条目 → FlyaiKeywordOption(官方形状 itemList[].info) */
function parseKeywordItems(items: unknown[]): ParsedItems<FlyaiKeywordOption> {
  const options: FlyaiKeywordOption[] = []
  let malformedCount = 0
  for (const raw of items) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      malformedCount += 1
      continue
    }
    const info = (raw as { info?: unknown }).info
    if (!info || typeof info !== 'object' || Array.isArray(info)) {
      malformedCount += 1
      continue
    }
    const it = info as Record<string, unknown>
    const title = nonEmptyText(it.title)
    const str = (key: string): string | undefined | 'bad' => {
      const v = it[key]
      if (v === undefined || v === null) return undefined
      return nonEmptyText(v) ?? 'bad'
    }
    const jumpUrl = str('jumpUrl')
    const picUrl = str('picUrl')
    const price = str('price')
    const scoreDesc = str('scoreDesc')
    const star = str('star')
    let tags: string[] | undefined | 'bad'
    if (it.tags !== undefined) {
      if (!Array.isArray(it.tags) || it.tags.some(t => nonEmptyText(t) === undefined)) tags = 'bad'
      else tags = it.tags.map(t => String(t).trim())
    }
    if (!title || [jumpUrl, picUrl, price, scoreDesc, star].includes('bad') || tags === 'bad') {
      malformedCount += 1
      continue
    }
    options.push({
      title,
      jumpUrl: jumpUrl ?? undefined,
      picUrl: picUrl ?? undefined,
      price: price ?? undefined,
      scoreDesc: scoreDesc ?? undefined,
      star: star ?? undefined,
      ...(tags ? { tags } : {}),
    })
  }
  return { options, malformedCount }
}

/** 万豪套餐条目 → FlyaiMarriottPackageOption */
function parsePackageItems(items: unknown[]): ParsedItems<FlyaiMarriottPackageOption> {
  const options: FlyaiMarriottPackageOption[] = []
  let malformedCount = 0
  for (const raw of items) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      malformedCount += 1
      continue
    }
    const it = raw as RawItem
    const name = nonEmptyText(it.name)
    const fields_ = [
      stringField(it, 'brandName'), stringField(it, 'hotelName'), stringField(it, 'cityName'),
      stringField(it, 'price'), stringField(it, 'detailUrl'), stringField(it, 'mainPic'),
      stringField(it, 'sellingPoint'),
    ]
    if (!name || fields_.includes('bad')) {
      malformedCount += 1
      continue
    }
    const [brandName, hotelName, cityName, price, detailUrl, mainPic, sellingPoint] = fields_ as Array<string | null>
    options.push({
      name,
      brandName: brandName ?? undefined,
      hotelName: hotelName ?? undefined,
      cityName: cityName ?? undefined,
      price: price ?? undefined,
      detailUrl: detailUrl ?? undefined,
      mainPic: mainPic ?? undefined,
      sellingPoint: sellingPoint ?? undefined,
    })
  }
  return { options, malformedCount }
}

// ── 候选 key 验证(setup 用:scrub env 注入候选,绝不被旧 env 遮蔽) ────────

export interface FlyaiVerifyOutcome {
  ok: boolean
  verdict: FlyaiVerdict
  retryable?: boolean
  evidence: string
  latencyMs: number
  maskedKey?: string
  error?: string
  setup?: string
}

/**
 * 用候选 key 做一次最便宜只读验证。
 * env 先 scrub(删 FLYAI_API_KEY/DEBUG_FLYAI_API_KEY),再注入候选:
 * 保证验证请求确实用候选 key,不被当前进程旧 env 遮蔽。
 * 不传 candidate:验证当前生效来源(匿名态亦可)。
 */
export async function verifyFlyaiKey(opts: {
  candidate?: string
  cliBin?: string
  cliPrefixArgs?: string[]
  timeoutMs?: number
  signal?: AbortSignal
}): Promise<FlyaiVerifyOutcome> {
  const started = Date.now()
  const candidate = opts.candidate?.trim()
  const env: NodeJS.ProcessEnv = { ...process.env }
  delete env.FLYAI_API_KEY
  delete env.DEBUG_FLYAI_API_KEY
  if (candidate) env.FLYAI_API_KEY = candidate

  const q: FlyaiQuery = {
    kind: 'flight', origin: '上海', destination: '丽江', depDate: '2026-10-01',
    timeoutMs: opts.timeoutMs ?? 20_000,
    ...(opts.cliBin ? { cliBin: opts.cliBin } : {}),
    ...(opts.cliPrefixArgs ? { cliPrefixArgs: opts.cliPrefixArgs } : {}),
  }
  const r = await flyaiSearchWithEnv(q, env)
  return {
    ok: r.verdict === 'hit',
    verdict: r.verdict,
    ...(r.retryable !== undefined ? { retryable: r.retryable } : {}),
    evidence: r.evidence,
    latencyMs: Date.now() - started,
    ...(candidate ? { maskedKey: candidate.length <= 4 ? '****' : `****${candidate.slice(-4)}` } : {}),
    ...(r.error ? { error: r.error } : {}),
    ...(r.setup ? { setup: r.setup } : {}),
  }
}

/** flyaiSearch 的 env 注入变体(仅候选验证用;生产路径 env 原样透传) */
async function flyaiSearchWithEnv(q: FlyaiQuery, env: NodeJS.ProcessEnv): Promise<FlyaiResult> {
  const started = Date.now()
  const ts = new Date().toISOString()
  const built = buildCliArgs(q)
  if (built.error) return badArg(q.kind, built.error, ts)

  const keySource: FlyaiKeySource = env.FLYAI_API_KEY ? 'env' : env.DEBUG_FLYAI_API_KEY ? 'env-debug' : 'none'
  const prefix = q.cliPrefixArgs ?? ['-y', '@fly-ai/flyai-cli']
  const r = await sh(q.cliBin ?? 'npx', [...prefix, ...built.args!], {
    timeoutMs: q.timeoutMs ?? 20_000,
    env,
    signal: q.signal,
  })
  const latencyMs = Date.now() - started
  const combined = `${r.stderr}\n${r.stdout}`
  const endpoint = resolveFlyaiEndpoint({ env })
  const envNote = { keySource, ...(endpoint.debug ? { endpointDebug: true } : {}) }
  const sensitive: FlyaiSensitiveContext = {
    ...(env.FLYAI_API_KEY ? { key: env.FLYAI_API_KEY } : {}),
    ...(endpoint.debug ? { debugEndpoint: endpoint.url } : {}),
  }
  const safe = <T extends FlyaiResult>(result: T): T => safeFlyaiResult(result, sensitive)
  if (r.cancelled) {
    return safe({
      kind: q.kind, ...envNote, latencyMs, ok: false, via: 'flyai-error', verdict: 'cancelled',
      evidence: `[实时API:flyai@error@${ts}] candidate verify cancelled`,
      error: '候选 key 验证被取消',
    })
  }
  if (r.timedOut) {
    return safe({
      kind: q.kind, ...envNote, latencyMs, ok: false, via: 'flyai-error', verdict: 'timeout',
      retryable: true,
      evidence: `[实时API:flyai@error@${ts}] timeout after ${q.timeoutMs ?? 20_000}ms`,
      error: 'FlyAI 验证调用超时',
    })
  }
  if (r.error || r.code !== 0 || /HTTP\s*(4\d\d|5\d\d)/.test(combined)) {
    return safe(classifyUpstreamFailure(q.kind, r, latencyMs, ts, envNote))
  }
  let items: unknown[]
  try {
    items = parseFlyaiItemList(r.stdout)
  } catch (e) {
    const raw = r.stdout.replace(/\s+/g, ' ').slice(0, 160)
    return safe({
      kind: q.kind, ...envNote, latencyMs, ok: false, via: 'flyai-error', verdict: 'error',
      evidence: `[实时API:flyai@error@${ts}] parse failed: ${raw}`,
      error: `verify parse failed (${(e as Error).message}): ${raw}`,
    })
  }
  return safe(parseItemListResult(q.kind, items, latencyMs, ts, envNote, r.stdout))
}
