/**
 * GoTry dsh 插件(gotry-tools):把 GoTry 的领域能力注册为 dsh 工具。
 *
 * 对应总纲 3.2 插件清单中的三个最小集:
 *   - gotry_feasibility_check   可行性引擎(门到门全成本,bridge → Python Z3)
 *   - gotry_motivation_save     动机画像落盘(为什么出发;B2B 接缝的契约对象)
 *   - gotry_wish_pool_add       「下一次出发」清单(憧憬不被拒绝)
 *
 * 插件形态遵循 dsh 约定(name/inject/Config/apply + ctx.tools.register(defineTool(...))),
 * 对齐已发布 @deepseek-ai/dsh-tools@0.0.1-rc.1 的契约:
 * render 位于 output 对象内,参数属性是 ValueSchemaSpec(支持 type:'json')。
 *
 * @module @gotry/plugin
 */

import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { ensureStateDir, readJson, recordLatency, writeJson } from './bridge.ts'
import { segmentsFromCandidate, solveChoiceSegment } from './unified.ts'
import { checkConnectivity } from '../scripts/skeleton-check.ts'
import { parseCandidate, parseRequest } from './model.ts'
import { searchHotels as hbcliSearchHotels } from '../capabilities/hbcli.ts'
import { installProcessGuards } from '../capabilities/incident-log.ts'
import { geocodePlace, getForecast, getClimate, wmoLabel } from '../capabilities/weather.ts'

export const name = 'gotry-tools'
export const inject = ['tools', 'systemPrompt']

export interface Config {
  /** 状态根目录(动机画像、wish pool、延迟日志) */
  stateRoot: string
  /** 引擎调用超时(ms) */
  timeoutMs: number
  /** hbcli 二进制路径(hotelbyte-cli;空=禁用实时酒店,回退数据包) */
  hbcliBin: string
}

export const Config: z<Config> = z.object({
  stateRoot: z.string().default('.'),
  timeoutMs: z.number().default(30_000),
  hbcliBin: z.string().default('hbcli'),
})

interface FeasibilityResult {
  answer_md?: string
}

interface MotivationProfileInput {
  weights?: Record<string, number>
  evidence?: string[]
  hard?: Record<string, unknown>
}

interface WishPoolEntryInput {
  name?: string
  reason?: string
  conditions?: Record<string, unknown>
}

type Json = string | number | boolean | null | Json[] | { [k: string]: Json }
type JsonObject = { [k: string]: Json }

export function apply(ctx: Context, config: Config): void {
  // 时间感知:注册动态变量,persona 里用 {{current_date}} 引用。
  // 每次 assemble 时取系统时钟——LLM 始终知道「今天是几号」。
  const sp = (ctx as unknown as Record<string, unknown>)['systemPrompt'] as {
    variable?: (name: string, provider: () => string) => void
  } | undefined
  sp?.variable?.('current_date', () => {
    const d = new Date()
    const ymd = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    const weekdays = ['日', '一', '二', '三', '四', '五', '六']
    return `${ymd} 周${weekdays[d.getDay()]}`
  })

  // D-NEW 进程护栏(Z3 WASM crash 教训):dsh 0.1.1-rc.1 缺 uncaughtException
  // handler,插件异常穿透即杀进程。我们在 gotry 侧挂护栏:同步 fsync 写事故证据
  // (gotry-state/incidents.jsonl),handler 自身不再抛,不阻塞后续控制流。
  // 不调 process.exit——让 dsh/上级容器决定生死,我们只留现场。
  installProcessGuards(config.stateRoot ?? '.', { uncaughtException: 'gotry-tools', unhandledRejection: 'gotry-tools' })

  ctx.tools.register(defineTool({
    name: 'gotry_feasibility_check',
    description:
      'Check travel candidates against the user\'s motivation and hard constraints using the '
      + 'door-to-door true-cost engine (wake time, arrival state, energy, usable hours, money). '
      + 'Input is the structured request (motivation weights + hard constraints + window + budget + home hubs) '
      + 'and the candidate list (services/transfers/stay costs/min days), same shape as data/golden_erhai.json. '
      + 'Returns per-candidate verdicts, unsat cores with minimal-modification suggestions, '
      + 'a wish-pool entry for infeasible aspirations, and a ready-to-show markdown answer.',
    parameters: {
      payload: {
        type: 'json',
        required: true,
        description: 'The full engine payload: { request, candidates }.',
      },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{
        type: 'text',
        text: String((value as FeasibilityResult).answer_md ?? JSON.stringify(value)),
      }],
    },
    async execute(args: { payload: unknown }, _exec: unknown) {
      // 纯 TS 路径:D-7 后 unified solveChoiceSegment 是唯一求解入口(无 Python 桥、无 z3 WASM
      // 路径——候选形态枚举求解,~6ms/次)。unified 内部有 try-catch 护栏覆盖 wasm 异常。
      const started = Date.now()
      const payload = args.payload as Record<string, unknown>
      const req = parseRequest(payload['request'] as Record<string, unknown>)
      const cands = (payload['candidates'] as Record<string, unknown>[]).map(parseCandidate)
      const spec = segmentsFromCandidate(req, cands)
      const result = solveChoiceSegment(spec, req) as Record<string, unknown>
      const dir = await ensureStateDir(config.stateRoot)
      await recordLatency(join(dir, 'bridge-latency.jsonl'), Date.now() - started, 'feasibility_check:in-process-unified').catch(() => {})
      return { ...result, latency_ms: Date.now() - started, via: 'in-process-unified' }
    },
    presentCall: args => ({ card: 'generic', title: 'GoTry 可行性检查(门到门全成本)', kind: 'other', rawInput: args.payload }),
  }))

  ctx.tools.register(defineTool({
    name: 'gotry_motivation_save',
    description:
      'Persist the traveler\'s motivation profile (the "why depart" contract object). '
      + 'This is the B2B reuse seam: downstream plugins consume only MotivationProfile + constraints, '
      + 'never the principal/sponsor distinction. Requires an evidence field: every weight must trace '
      + 'back to the user\'s own words (P0 anti-fabrication rule).',
    parameters: {
      profile: {
        type: 'json',
        required: true,
        description: '{ weights: {escape_rest: 0.7, ...}, evidence: [user quotes...], hard: {wake_not_before, min_arrival_energy_pct} }',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          saved: { type: 'boolean' },
          path: { type: 'string' },
          profile: { type: 'json' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `动机画像已保存:${String((value as { path?: string }).path ?? '')}` }],
    },
    async execute(args: { profile: unknown }, _exec: unknown) {
      const profile = (args.profile ?? {}) as MotivationProfileInput
      if (!profile.evidence?.length) {
        throw new Error('refusing to save a motivation profile without evidence (P0 anti-fabrication rule)')
      }
      const dir = await ensureStateDir(config.stateRoot)
      const path = join(dir, 'motivation-profile.json')
      // JSON 往返保证落盘值与输出值都是 JsonValue(输出 schema 的硬要求)
      const saved = JSON.parse(JSON.stringify({ ...profile, updated_at: new Date().toISOString() })) as JsonObject
      await writeJson(path, saved)
      return { saved: true, path, profile: saved }
    },
    presentCall: args => ({ card: 'generic', title: '保存动机画像', kind: 'other', rawInput: args.profile }),
  }))

  ctx.tools.register(defineTool({
    name: 'gotry_wish_pool_add',
    description:
      'Add an aspiration to the "next departure" wish pool — the graceful home for infeasible dreams. '
      + 'An entry carries its fulfilment conditions (days needed, budget, best months) so a future '
      + '"next departure" nudge can fire when the window matches. 憧憬不被拒绝。',
    parameters: {
      entry: {
        type: 'json',
        required: true,
        description: '{ name, reason, conditions: { days, budget_cny, best_months } }',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          added: { type: 'boolean' },
          total: { type: 'integer' },
          path: { type: 'string' },
        },
      },
      render: (_args, value) => {
        const v = value as { total?: number; path?: string }
        return [{ type: 'text', text: `已加入「下一次出发」清单(共 ${v.total ?? '?'} 项):${v.path ?? ''}` }]
      },
    },
    async execute(args: { entry: unknown }, _exec: unknown) {
      const entry = (args.entry ?? {}) as WishPoolEntryInput
      if (!entry.name || !entry.conditions) {
        throw new Error('wish pool entry requires name and conditions (fulfilment conditions are the whole point)')
      }
      const dir = await ensureStateDir(config.stateRoot)
      const path = join(dir, 'wish-pool.json')
      const pool = (await readJson(path, [])) as Array<Record<string, unknown>>
      // 同名憧憬幂等更新(刷新理由与成行条件),不重复落盘
      const existing = pool.findIndex(e => e['name'] === entry.name)
      if (existing >= 0) {
        pool[existing] = { ...pool[existing], reason: entry.reason ?? pool[existing]?.['reason'], conditions: entry.conditions }
        await writeJson(path, pool)
        return { added: false, total: pool.length, path }
      }
      pool.push({ reason: '', ...entry, added_at: new Date().toISOString() })
      await writeJson(path, pool)
      return { added: true, total: pool.length, path }
    },
    presentCall: args => ({ card: 'generic', title: '加入「下一次出发」清单', kind: 'other', rawInput: args.entry }),
  }))

  ctx.tools.register(defineTool({
    name: 'gotry_hotel_search',
    description:
      'Search hotels via hotelbyte-cli (real-time when hbcli credentials exist, falls back to the static pack with explicit evidence tagging). '
      + 'Input: destination city name + optional dates/occupancy. Output: hotel list with evidence chain ([realtime-API:hbcli] + fetch timestamp, '
      + 'or [static-pack:estimate]) per the L4 invariant.',
    parameters: {
      query: {
        type: 'json',
        required: true,
        description: '{ destination: "普吉", checkIn?: "2026-07-18", checkOut?: "2026-07-23", occupancy?: { adults: 2 } }',
      },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: String((value as { summary?: string }).summary ?? JSON.stringify(value).slice(0, 400)) }],
    },
    async execute(args: { query: unknown }, _exec: unknown) {
      const q = (args.query ?? {}) as { destination?: string; checkIn?: string; checkOut?: string; adults?: number }
      if (!q.destination) throw new Error('gotry_hotel_search requires destination')
      const started = Date.now()
      const fallbackPath = join(import.meta.dirname, '..', '..', 'data', 'hotels_2026.json')
      const resp = await hbcliSearchHotels(
        { destination: q.destination, checkIn: q.checkIn, checkOut: q.checkOut, adults: q.adults },
        { hbcliBin: config.hbcliBin, timeoutMs: config.timeoutMs, fallbackPath },
      )
      const dir = await ensureStateDir(config.stateRoot)
      const isLive = resp.via === 'hbcli-realtime'
      const evidence = isLive ? resp.evidence : '[静态包:估算]'
      await recordLatency(join(dir, 'bridge-latency.jsonl'), Date.now() - started, `hotel_search:${resp.via}`).catch(() => {})
      const payload = {
        hotels: resp.hotels ?? null,
        evidence,
        destination: q.destination,
        via: resp.via,
        latency_ms: Date.now() - started,
        summary: resp.summary,
        error: resp.error,
      }
      return JSON.parse(JSON.stringify(payload)) as Record<string, unknown>
    },
    presentCall: args => ({ card: 'generic', title: `酒店搜索:${String((args.query as { destination?: string })?.destination ?? '')}`, kind: 'other', rawInput: args.query }),
  }))

  ctx.tools.register(defineTool({
    name: 'gotry_skeleton_check',
    description:
      'Check flight connectivity between two airports against the OpenFlights skeleton (free tier). '
      + 'Three-valued: found = strong positive (airlines returned); hub-to-hub absence = downgrade signal, NEVER disproof '
      + '(skeleton lags reality); outside hub set = no conclusion. Use BEFORE recommending a route.',
    parameters: {
      from: { type: 'string', required: true, description: 'IATA, e.g. HKG' },
      to: { type: 'string', required: true, description: 'IATA, e.g. HKT' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          connected: { type: 'boolean' },
          airlines: { type: 'array', items: { type: 'string' } },
          evidence: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: String((value as { evidence?: string }).evidence ?? '') }],
    },
    async execute(args: { from: string; to: string }, _exec: unknown) {
      const verdict = await checkConnectivity(args.from, args.to)
      return JSON.parse(JSON.stringify(verdict)) as Record<string, never>
    },
    presentCall: args => ({ card: 'generic', title: `骨架校验:${args.from}-${args.to}`, kind: 'other', rawInput: args }),
  }))

  ctx.tools.register(defineTool({
    name: 'gotry_weather_check',
    description:
      'Check weather for a destination: forecast (≤16 days) or historical climate (seasonality baseline). '
      + 'Free Open-Meteo API, no key required. Input: place name (Chinese ok) or lat/lng. '
      + 'Returns daily temp range, precipitation probability, weather code — with evidence chain tagging '
      + '[实时API:open-meteo@ts]. Use to ground seasonal advice in real data instead of LLM guessing.',
    parameters: {
      query: {
        type: 'json',
        required: true,
        description: '{ place: "大理市", month?: 8, mode?: "forecast"|"climate", days?: 7 }',
      },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: String((value as { summary?: string }).summary ?? JSON.stringify(value).slice(0, 600)) }],
    },
    async execute(args: { query: unknown }, _exec: unknown) {
      const q = (args.query ?? {}) as { place?: string; lat?: number; lng?: number; month?: number; mode?: string; days?: number }
      const started = Date.now()
      let lat: number | undefined = q.lat, lng: number | undefined = q.lng
      let placeLabel = q.place ?? `${q.lat},${q.lng}`
      if (lat === undefined || lng === undefined) {
        if (!q.place) throw new Error('gotry_weather_check requires place name or lat/lng')
        const geo = await geocodePlace(q.place)
        if (!geo.ok || geo.results.length === 0) {
          return JSON.parse(JSON.stringify({ ok: false, summary: `地点「${q.place}」地理编码失败:${geo.error ?? '无结果'}`, evidence: geo.evidence })) as Record<string, never>
        }
        const hit = geo.results[0]
        lat = hit.latitude; lng = hit.longitude
        placeLabel = `${hit.name}(${hit.admin1 ?? hit.country ?? ''})`
      }
      const isClimate = q.mode === 'climate' || (q.month !== undefined && q.mode !== 'forecast')
      const r = isClimate
        ? await getClimate({ latitude: lat, longitude: lng }, q.month ?? new Date().getMonth() + 1)
        : await getForecast({ latitude: lat, longitude: lng }, { days: q.days })
      const dir = await ensureStateDir(config.stateRoot)
      await recordLatency(join(dir, 'bridge-latency.jsonl'), Date.now() - started, `weather:${r.via}`).catch(() => {})
      const dailyLines = (r.daily ?? []).slice(0, 7).map(d =>
        `${d.date} ${d.tempMinC.toFixed(0)}–${d.tempMaxC.toFixed(0)}°C ${wmoLabel(d.weatherCode)}${d.precipProbMaxPct !== null ? ` 降水概率${d.precipProbMaxPct}%` : ''}`)
      const summary = r.ok
        ? `${placeLabel}:${isClimate ? '历史气候' : `${q.days ?? 7} 天预报`}\n${dailyLines.join('\n')}\n${r.evidence}`
        : `${placeLabel}:天气查询失败(${r.error})${r.evidence}`
      return JSON.parse(JSON.stringify({
        ok: r.ok, place: placeLabel, mode: isClimate ? 'climate' : 'forecast',
        daily: r.daily, evidence: r.evidence, summary,
        latency_ms: Date.now() - started,
      })) as Record<string, never>
    },
    presentCall: args => ({ card: 'generic', title: `天气:${String((args.query as { place?: string })?.place ?? '')}`, kind: 'other', rawInput: args.query }),
  }))
}
