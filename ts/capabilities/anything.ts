/**
 * Anything 通用搜索能力层:hbcli → hotel-be Anything 函数。
 *
 * 链路(同构 hbcli.ts):
 *   gotry capabilities/anything.ts
 *     → spawn hbcli search anything [keywords...] --json <opts>
 *       → hotel-be /api/search/anything
 *         → search/service/geography.go func Anything (mixed 城市+酒店搜索)
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

export interface AnythingQuery {
  /** 多词以空格 join,与 hbcli argument-parser 一致;前后 trim。空则报错(unless contentType 强限定) */
  keyword: string
  /** 'city' | 'hotel' | undefined(混合) */
  contentType?: 'city' | 'hotel'
  /** 限定子区域 ID(可选) */
  parentDestinationId?: string | number
  /** 默认 12_000 ms */
  timeoutMs?: number
  /** 显式 hbcli 路径(默认 'hbcli',从 $PATH 找) */
  hbcliBin?: string
}

export interface AnythingHit {
  type: 'city' | 'hotel' | 'place'
  /** FuzzySearchItem name(or hotel name);fallback 为 region.Name */
  name: string
  /** score / 0..1(若返回) */
  score?: number
  /** lat/lng(若 region 给出) */
  latitude?: number
  longitude?: number
  /** city id(若有) */
  destinationId?: string
  /** hotel id(若有) */
  hotelId?: string
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

interface RawSearchResp {
  candidates?: RawSearchItem[]
}
interface RawSearchItem {
  type?: string
  name?: string
  label?: string
  region?: { id?: string; name?: string; latitude?: number; longitude?: number; typeScore?: number; name_en?: string; name_zh?: string }
  hotel?: { id?: string; name?: string; latitude?: number; longitude?: number }
  score?: number
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
    child.stdout.on('data', (d: Buffer) => { stdout += d.toString() })
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString() })
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

const upperFirst = (s: string): string => (s ? s[0]!.toUpperCase() + s.slice(1) : s)
const lowerFirst = (s: string): string => (s ? s[0]!.toLowerCase() + s.slice(1) : s)

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
  const bin = q.hbcliBin ?? 'hbcli'
  const args = [bin, 'search', 'anything', kw]
  if (q.contentType) args.push('--content-type', q.contentType)
  if (q.parentDestinationId !== undefined) {
    args.push('--parent-destination-id', String(q.parentDestinationId))
  }

  const r = await sh(bin, args.slice(1), {
    timeoutMs: q.timeoutMs ?? 12_000,
    env: process.env,
  })
  const latencyMs = Date.now() - started

  if (r.error || r.code !== 0) {
    return {
      ok: false,
      via: 'hbcli-anything-error',
      evidence: `[实时API:hbcli-anything@error@${ts}] ${r.error ?? `exit ${r.code}`}`,
      latencyMs,
      verdict: 'error',
      error: r.error ?? `${r.stderr.slice(0, 200)} (exit ${r.code})`,
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
    const isHotel = it.type === 'hotel' || it.type === 'SupplierHotelList' || Boolean(hotel.id)
    return {
      type: (isHotel ? 'hotel' : (it.type === 'place' || it.type === 'City' ? lowerFirst(it.type) : 'city')) as AnythingHit['type'],
      name: it.name ?? region.name_en ?? region.name ?? hotel.name ?? '?',
      score: it.score ?? region.typeScore,
      latitude: hotel.latitude ?? region.latitude,
      longitude: hotel.longitude ?? region.longitude,
      destinationId: region.id,
      hotelId: hotel.id,
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

// noop exports to keep file shape consistent with hbcli.ts
export const _ = { upperFirst }
