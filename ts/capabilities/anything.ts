/**
 * Anything 通用搜索能力层:hbcli → hotel-be Anything 函数。
 *
 * 链路(同构 hbcli.ts):
 *   gotry capabilities/anything.ts
 *     → spawn hbcli --json search anything <kw> [opts]
 *       → hotel-be /api/search/anything(httpdispatch 自动注册;httpdispatch 路由面)
 *         → search/service/geography.go func Anything (mixed 城市+酒店搜索)
 *
 * wire 契约(2026-09-07 对齐上游源码;SearchItem = FuzzySearchItem + hotel):
 *   req  { keyword, contentType?, context.destinationId?, minHotelCount? }
 *   resp { candidates: [{ type: 'city'|'place'|'hotel',
 *                         region?:  { id, name:{en,zh,ar}, coordinates:{centerLat,centerLng}, countryCode, … },
 *                         place?:   { latlngCoordinator },
 *                         matchScore?, hotel?: { id, name:{en,zh,ar}, star, latlngCoordinator:{google|gaode:{lat,lng} } } }] }
 *
 * 三值语义:
 *   - hit:  命中候选(混合 city/hotel,maybe-coords)
 *   - miss: hbcli exit 0,但 candidates 为空(查无结果)
 *   - err:  hbcli exit ≠ 0 或超时(降级,降级产物 标 [实时API:hbcli-anything@error@ts])
 *
 * 契约(与 hbcli/weather/opensky 同构,L4 不变量):
 *   - 永不抛错:网络/超时/解析失败一律降级返回;
 *   - 证据链标注:成功 [实时API:hbcli-anything@ts];失败 [实时API:hbcli-anything@error@ts];
 *   - 永不阻塞调用方:周边有 12s 默认超时,LLM 不等。
 *
 * 第 7 个能力层(与 hbcli.ts / weather.ts / opensky.ts 平级),data-sources.md §4
 * Google Place 链路的「酒店-be 中间层」入口。
 */

import { spawn } from 'node:child_process'
import { hbcliBinCandidates } from './hbcli.ts'

export interface AnythingQuery {
  /** 多词以空格 join,与 hbcli argument-parser 一致;前后 trim。空则报错(unless contentType 强限定) */
  keyword: string
  /** 'city' | 'hotel' | undefined(混合) */
  contentType?: 'city' | 'hotel'
  /** 限定子区域 ID(上游 SearchReq.context.destinationId) */
  parentDestinationId?: string | number
  /** 默认 12_000 ms */
  timeoutMs?: number
  /** 显式 hbcli 路径(默认 'hbcli',从 $PATH 找;默认名自动回退 ~/.local/bin 等已知安装位) */
  hbcliBin?: string
}

export interface AnythingHit {
  type: 'city' | 'hotel' | 'place'
  /** i18n name 解析(zh 优先,产品中文优先;回退 en/ar) */
  name: string
  /** matchScore(文本相关度,越高越匹配) */
  score?: number
  /** lat/lng(region.center 或 hotel/place latlngCoordinator,若给出) */
  latitude?: number
  longitude?: number
  /** city id(region.id;酒店候选为所属 destinationId) */
  destinationId?: string
  /** hotel id(若有) */
  hotelId?: string
  /** 星级(酒店候选,若返回) */
  star?: number
}

export interface AnythingResult {
  ok: boolean
  via: 'hbcli-anything' | 'hbcli-anything-error'
  evidence: string
  latencyMs: number
  /** 三值 */
  verdict: 'hit' | 'miss' | 'error'
  hits?: AnythingHit[]
  totalCandidates?: number
  error?: string
}

/** 上游 i18n.I18N {en,zh,ar};tolerant 读取(字段可能缺省,老字符串形态也兜住) */
type I18N = { en?: string; zh?: string; ar?: string } | string | undefined

function i18nText(v: I18N): string {
  if (!v) return ''
  if (typeof v === 'string') return v
  return v.zh || v.en || v.ar || ''
}

/** hotel-be Latlng:{lat,lng};google/gaode 双源取先非零者 */
function latlngOf(coord: { google?: { lat?: number; lng?: number }; gaode?: { lat?: number; lng?: number } } | undefined): { latitude?: number; longitude?: number } {
  for (const src of [coord?.google, coord?.gaode]) {
    const lat = typeof src?.lat === 'number' ? src.lat : undefined
    const lng = typeof src?.lng === 'number' ? src.lng : undefined
    if (lat !== undefined && lng !== undefined && (lat !== 0 || lng !== 0)) return { latitude: lat, longitude: lng }
  }
  return {}
}

interface RawSearchResp {
  candidates?: RawSearchItem[]
}
/** hotel-be SearchItem wire 形状(FuzzySearchItem + hotel,2026-09-07 对齐源码) */
interface RawSearchItem {
  type?: string
  matchScore?: number
  region?: {
    id?: string | number
    name?: I18N
    countryCode?: string
    coordinates?: { centerLat?: number; centerLng?: number }
  }
  place?: { latlngCoordinator?: { google?: { lat?: number; lng?: number }; gaode?: { lat?: number; lng?: number } } }
  hotel?: {
    id?: string | number
    name?: I18N
    star?: number
    destinationId?: string | number
    latlngCoordinator?: { google?: { lat?: number; lng?: number }; gaode?: { lat?: number; lng?: number } }
  }
}

function sh(cmd: string, args: string[], opts: { timeoutMs: number; env: NodeJS.ProcessEnv }) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => {
    ctrl.abort()
    // AbortSignal on spawn 会发 SIGTERM;对于不响应 SIGTERM 的子进程,需要在外部再发一次 SIGKILL。
    // Node 不能直接通过 AbortController 拿 child pid,所以需要借助外部变量保存 child。
  }, opts.timeoutMs)
  let child: ReturnType<typeof spawn> | null = null
  let killTimer: NodeJS.Timeout | null = null
  return new Promise<{ code: number; stdout: string; stderr: string; error?: string }>((resolve) => {
    child = spawn(cmd, args, {
      env: opts.env,
      cwd: process.cwd(),
      signal: ctrl.signal,
    })
    let stdout = ''
    let stderr = ''
    let error: string | undefined
    let killed = false
    child.stdout?.on('data', (d: Buffer) => { stdout += d.toString() })
    child.stderr?.on('data', (d: Buffer) => { stderr += d.toString() })
    child.on('error', (e) => { error = (e as Error).message.slice(0, 200) })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (killTimer) clearTimeout(killTimer)
      resolve({ code: killed ? -2 : (code ?? -1), stdout, stderr, error })
    })
    // Abort 后 500ms 内若子进程仍活,发 SIGKILL 强杀。
    ctrl.signal.addEventListener('abort', () => {
      if (!child) return
      try {
        child.kill('SIGTERM')
      } catch { /* ignore */ }
      killTimer = setTimeout(() => {
        try { child?.kill('SIGKILL') } catch { /* ignore */ }
      }, 500)
    })
  })
}

/** --json 必须在子命令前(cli.ts 全局旗标预扫描只认子命令前位置;JSON 错误也走结构化 stderr) */
function buildArgs(keyword: string, q: AnythingQuery): string[] {
  const args = ['--json', 'search', 'anything', keyword]
  if (q.contentType) args.push('--content-type', q.contentType)
  if (q.parentDestinationId !== undefined) args.push('--destination-id', String(q.parentDestinationId))
  return args
}

/** 旧版 CLI 无 search anything 子命令时的可行动升级指引(issue #195:裸 unknown command 读起来像工具坏了) */
function upgradeHint(stderr: string): string | null {
  return /unknown command/i.test(stderr)
    ? 'hbcli 版本过旧(无 search anything 子命令)——请升级:hbcli update,或重跑 npx gotry setup'
    : null
}

/** Anything 通用搜索 — 任何搜索失败走降级;不抛错 */
export async function anythingSearch(q: AnythingQuery): Promise<AnythingResult> {
  const started = Date.now()
  const ts = new Date().toISOString()
  const kw = (q.keyword ?? '').trim()
  if (!kw) {
    return {
      ok: false, via: 'hbcli-anything-error',
      evidence: `[实时API:hbcli-anything@error@${ts}] keyword empty`,
      latencyMs: Date.now() - started, verdict: 'error',
      error: 'keyword is required',
    }
  }
  const args = buildArgs(kw, q)
  // spawn 级失败(ENOENT)按已知安装位回退(hbcli.ts callHbcliJson 同款);其余失败无重试意义
  const candidates = hbcliBinCandidates(q.hbcliBin ?? 'hbcli')
  let r: { code: number; stdout: string; stderr: string; error?: string } = { code: -1, stdout: '', stderr: '' }
  for (let i = 0; i < candidates.length; i++) {
    r = await sh(candidates[i]!, args, { timeoutMs: q.timeoutMs ?? 12_000, env: process.env })
    if (!(r.error && i < candidates.length - 1)) break
  }
  const latencyMs = Date.now() - started

  if (r.error || r.code !== 0) {
    const raw = r.error ?? `${r.stderr.slice(0, 200)} (exit ${r.code})`
    return {
      ok: false,
      via: 'hbcli-anything-error',
      evidence: `[实时API:hbcli-anything@error@${ts}] ${raw}`,
      latencyMs,
      verdict: 'error',
      error: upgradeHint(r.stderr) ?? raw,
    }
  }

  let data: RawSearchResp
  try {
    const jStart = r.stdout.indexOf('{') >= 0 ? r.stdout.indexOf('{') : r.stdout.indexOf('[')
    const json = jStart >= 0 ? r.stdout.slice(jStart) : r.stdout
    data = JSON.parse(json) as RawSearchResp
  } catch {
    return {
      ok: false, via: 'hbcli-anything-error',
      evidence: `[实时API:hbcli-anything@error@${ts}] parse failed`,
      latencyMs,
      verdict: 'error',
      error: 'failed to parse hbcli output as JSON',
    }
  }

  const rawItems = data.candidates ?? []
  const hits: AnythingHit[] = rawItems.map((it) => {
    const region = it.region ?? {}
    const hotel = it.hotel ?? {}
    const isHotel = it.type === 'hotel' || Boolean(hotel.id)
    const hotelCoords = latlngOf(hotel.latlngCoordinator)
    const placeCoords = latlngOf(it.place?.latlngCoordinator)
    const center = region.coordinates ?? {}
    return {
      type: (isHotel ? 'hotel' : (it.type === 'place' ? 'place' : 'city')) as AnythingHit['type'],
      name: i18nText(hotel.name) || i18nText(region.name) || '?',
      score: it.matchScore,
      latitude: hotelCoords.latitude ?? placeCoords.latitude ?? (typeof center.centerLat === 'number' ? center.centerLat : undefined),
      longitude: hotelCoords.longitude ?? placeCoords.longitude ?? (typeof center.centerLng === 'number' ? center.centerLng : undefined),
      destinationId: hotel.destinationId !== undefined ? String(hotel.destinationId) : (region.id !== undefined ? String(region.id) : undefined),
      hotelId: hotel.id !== undefined ? String(hotel.id) : undefined,
      star: typeof hotel.star === 'number' && hotel.star > 0 ? hotel.star : undefined,
    }
  })

  const verdict: AnythingResult['verdict'] = hits.length > 0 ? 'hit' : 'miss'
  return {
    ok: true, via: 'hbcli-anything',
    evidence: `[实时API:hbcli-anything@${ts}] ${hits.length}/${rawItems.length} candidates`,
    latencyMs,
    verdict,
    hits,
    totalCandidates: rawItems.length,
  }
}
