/**
 * GoTry dsh 插件(gotry-tools):把 GoTry 的领域能力注册为 dsh 工具。
 *
 * 对应总纲 3.2 插件清单中的三个最小集:
 *   - gotry_feasibility_check   可行性引擎(门到门全成本,bridge → Python Z3)
 *   - gotry_motivation_save     动机画像落盘(为什么出发;B2B 接缝的契约对象)
 *   - gotry_wish_pool_add       「下一次出发」清单(憧憬不被拒绝)
 *
 * 插件形态遵循 dsh 约定(name/inject/Config/apply + ctx.tools.register(defineTool(...))),
 * 对齐 @deepseek-ai/dsh-tools@0.1.2-alpha.3 的契约:
 * render 位于 output 对象内,参数属性是 ValueSchemaSpec(支持 type:'json')。
 *
 * @module @gotry/plugin
 */

import { join } from 'node:path'

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { ensureStateDir, recordLatency } from './bridge.ts'
import { segmentsFromCandidate, solveChoiceSegment } from './unified.ts'
import { checkConnectivity } from '../scripts/skeleton-check.ts'
import { parseCandidate, parseRequest } from './model.ts'
import { installProcessGuards, guardToolExecute } from '../capabilities/incident-log.ts'
import { interpretArgs, type GotryObservation } from './tool-packet.ts'
import { projectUtility } from './memory-utility.ts'
import { pickNudgeWish, type WishPoolEntry } from './wish-pool.ts'
import { resolveTimelineDate } from './travel-timeline.ts'
import { ensureLedger, readCompanionsWithFallback, readMotivationWithFallback, readTripsWithFallback, readWishPoolWithFallback } from './state-ledger.ts'
import { buildTimeAnchor } from './time-anchor.ts'
import { resolveSlotDate } from './slot-spec.ts'
import { wmoLabel } from '../capabilities/weather.ts'
import { anythingSearch } from '../capabilities/anything.ts'
import { readUrl, reach, reachStatus } from '../capabilities/agent-reach.ts'
import { runDoctorChecks, renderDoctorReportMd } from '../capabilities/doctor.ts'
import { videoSubtitle, githubSearch } from '../capabilities/agent-reach-deep.ts'
import { sessionLogin } from '../capabilities/session-login.ts'
import { EXTENSION_STORE_URL } from '../capabilities/session/extension-bridge.ts'
import { createConsentGate, approvalFromContext } from '../capabilities/session-consent.ts'
import { installModelOverride } from '../capabilities/model-override.ts'
import { listArtifacts, readArtifact } from '../capabilities/artifacts.ts'
import { interpretEffect, declinedObservation } from '../capabilities/effect.ts'
import { appendFacts, loadFactRegistry } from '../capabilities/fact-log.ts'
import { factsFromFlyai, factsFromSession } from './bookable-facts.ts'
import { gateArtifact, type AirlineAirportMap } from './artifact-gate.ts'
import { installTurnDeadline, listTurnHandoffTickets } from './turn-deadline.ts'
import { noteChannelVerdict, recordChannelEvent } from '../capabilities/channel-health.ts'
import { routingAdvice, renderRoutingCard, type ChannelIntent } from '../capabilities/channel-registry.ts'
import { registerBenchmarkEnvironmentBridge, type BenchmarkSubprocessService } from './benchmark-environment-bridge.ts'
import { installBenchmarkToolIsolation } from './benchmark-tool-isolation.ts'
import { installBenchmarkAgentConformance } from './benchmark-agent-conformance.ts'

/** 航司→机场映射表(issue #46 冲突检测面;data/airline-airports.json,as_of 快照) */
let airlineAirportMapCache: AirlineAirportMap | null = null
async function loadAirlineAirportMap(): Promise<AirlineAirportMap | null> {
  if (airlineAirportMapCache) return airlineAirportMapCache
  try {
    const { readFile } = await import('node:fs/promises')
    airlineAirportMapCache = JSON.parse(
      await readFile(join(import.meta.dirname, '..', '..', 'data', 'airline-airports.json'), 'utf-8'),
    ) as AirlineAirportMap
    return airlineAirportMapCache
  } catch {
    return null // 映射缺失不阻塞检索主路径;闸工具侧另行显式报错
  }
}

export const name = 'gotry-tools'
// The bridge obtains subprocess through an optional Cordis lookup at apply
// time. Declaring it as a required injection would make the whole plugin
// depend on a service that is only needed for explicit benchmark opt-in.
export const inject = ['tools', 'systemPrompt']

export interface Config {
  /** 状态根目录(动机画像、wish pool、延迟日志) */
  stateRoot: string
  /** 引擎调用超时(ms) */
  timeoutMs: number
  /** hbcli 二进制路径(hotelbyte-cli;空=禁用实时酒店,回退数据包) */
  hbcliBin: string
  /** 账号会话检索总闸(RFC 支柱④「用户明示授权+随时可关」):ask=gotry_session_search 每会话每站点首次调用弹审批卡、会话内记住(默认);allow=用户已在配置明示预授权(直接放行);off=总闸关闭,直接拒绝 */
  sessionAccess: string
  /** Owner-local benchmark environment bridge config; empty disables the bridge. */
  benchmarkEnvironmentConfigPath?: string
}

export const Config: z<Config> = z.object({
  stateRoot: z.string().default('.'),
  timeoutMs: z.number().default(30_000),
  hbcliBin: z.string().default('hbcli'),
  sessionAccess: z.string().default('ask'),
  benchmarkEnvironmentConfigPath: z.string().default(''),
})

interface FeasibilityResult {
  answer_md?: string
  recommended?: string | null
  verdicts?: Array<Record<string, unknown>>
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


/**
 * query 包装参数的三形态归一(#12/#13):实现移居 tool-packet.ts(interpretArgs,
 * RFC S1 interpretation 层语义归位),此处按旧名引 handy 别名,调用点零漂移。
 */
const unwrapQuery = interpretArgs

/**
 * 动机画像 → persona 紧凑 brief(M4 T1 读回路径):空画像返回 ''(首访),
 * persona 据此决定是否访谈。只读,不猜——画像里没有的字段不编。
 * ADR-15:读经账本(未迁移 root 回退旧文件,只读)。
 */
function renderMotivationBrief(stateRoot: string): string {
  const p = readMotivationWithFallback(stateRoot)
  if (!p) return '' // 首访:无画像
  const lines: string[] = ['## 用户记忆(跨会话画像;与用户当轮说法冲突时以用户为准,更新经 gotry_motivation_save)']
  const weights = Object.entries(p.weights ?? {})
  if (weights.length) lines.push(`- 动机权重: ${weights.map(([k, v]) => `${k}=${v}`).join(', ')}(证据 ${p.evidence?.length ?? 0} 条)`)
  const hard = Object.entries(p.hard ?? {})
  if (hard.length) lines.push(`- 硬约束: ${hard.map(([k, v]) => `${k}=${String(v)}`).join(', ')}`)
  // 旅行时间线(memory-design P1):去过的地方不再主动推荐,除非用户点名
  const trips = readTimelineTrips(stateRoot)
  if (trips.length) {
    lines.push(`- 去过: ${trips.map(t => `${t.destination}(${t.start.slice(0, 7)})`).join('、')}——去过的地方不再主动推荐,除非用户点名`)
  }
  // 同行人档案(memory-design P2):约束只进排序与行程结构建议,永不硬过滤
  const companions = readCompanions(stateRoot)
  if (companions.length) {
    lines.push(`- 同行人: ${companions.map(c => `${c.label}(${c.brief})`).join('、')}——约束进结构与排序建议,不硬过滤;引用时带当初的原话依据`)
  }
  lines.push(`- 愿望池: 用 gotry_wish_pool_list 按条件召回(0..1),勿直接堆砌`)
  if (p.updated_at) lines.push(`- 更新于: ${p.updated_at}`)
  return weights.length || hard.length ? lines.join('\n') : ''
}

/** 时间线摘要(brief 用):最近 3 次行程(目的地+年月);账本优先,未迁移回退文件 */
/** 同行人摘要(brief 用):label + 约束串 */
function readCompanions(stateRoot: string): Array<{ label: string; brief: string }> {
  return readCompanionsWithFallback(stateRoot)
    .map(c => {
      const bits = [c.constraints.mobility, ...(c.constraints.health ?? []), ...(c.constraints.prefs ?? [])].filter(Boolean)
      return { label: c.label, brief: bits.join('/') }
    })
}

function readTimelineTrips(stateRoot: string): Array<{ destination: string; start: string }> {
  return readTripsWithFallback(stateRoot)
    .map(t => ({ destination: t.destination, start: t.start }))
    .sort((a, b) => (a.start < b.start ? 1 : -1))
    .slice(0, 3)
}

type Json = string | number | boolean | null | Json[] | { [k: string]: Json }
type JsonObject = { [k: string]: Json }

export function apply(ctx: Context, config: Config): void {
  const rawBenchmarkEnvironmentConfigPath = config.benchmarkEnvironmentConfigPath ?? ''
  // ADR-24 v2:产品路径装「路由 + wall-clock 双出口」——用户主观时间是唯一
  // 预算,复杂度决定出口结构(converge/handoff)。benchmark opt-in 钉死
  // 固定 policy 保证评测可复现,不走路由。GOTRY_HANDOFF_CHILD=1 是收集器
  // 派生的后台规划会话:唯一出口 converge + 长 leash——前台转后台,后台
  // 必须产出最终交付物,不得再次 handoff(否则无限递归)。
  const handoffChild = process.env.GOTRY_HANDOFF_CHILD === '1'
  installTurnDeadline(ctx, handoffChild
    ? { fixedPolicy: { softMs: 300_000, hardMs: 900_000, exit: 'converge' } }
    : rawBenchmarkEnvironmentConfigPath.trim()
      ? { fixedPolicy: { softMs: 60_000, hardMs: 120_000, exit: 'converge' } }
      : { stateRoot: process.env.GOTRY_TURN_HANDOFF_ROOT ?? config.stateRoot ?? '.' })
  if (rawBenchmarkEnvironmentConfigPath.trim()) {
    // Benchmark mode is a deliberately minimal kernel: only the model
    // override and the environment bridge are installed besides the pinned
    // turn-deadline policy above. In particular, product prompt variables,
    // process/consent guards, and guarded product tools must not be
    // observable on this path.
    installModelOverride(ctx as unknown as Parameters<typeof installModelOverride>[0])
    const getService = (ctx as unknown as { get?: (name: string, fallback?: unknown) => unknown }).get
    const directSubprocess = (typeof getService === 'function'
      ? getService.call(ctx, 'subprocess')
      : undefined) as BenchmarkSubprocessService | undefined
    const projection = registerBenchmarkEnvironmentBridge(
      rawBenchmarkEnvironmentConfigPath,
      tool => ctx.tools.register(tool),
      directSubprocess,
    )
    installBenchmarkToolIsolation(ctx)
    installBenchmarkAgentConformance(ctx, projection)
    return
  }

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
  // 时间锚点卡(time-anchor 层,确定性):相对日期换算的唯一依据——
  // 明天/下周X/下个月中旬/节日都查卡,LLM 不自算(算术只在代码层)。
  sp?.variable?.('time_anchor_card', () => buildTimeAnchor(new Date()).card)

  // M4 记忆读回(T1 闭环的另一半):motivation-profile 此前只写不读,每个新会话
  // 模型都是盲的、重新访谈——「回访规划时长降 ≥50%」不可能成立。这里把画像
  // 渲染成紧凑 brief 注入 persona;为空 = 首访。与当轮说法冲突时以用户为准。
  sp?.variable?.('motivation_brief', () => renderMotivationBrief(config.stateRoot ?? '.'))

  // 通道路由卡(通道注册表生成,tool-orchestration-design.md §2.1/D-8):
  // persona (19) 只留行为契约,机/火/酒通道顺位与额度口径查卡——prose 教义
  // 变查表教义,注册表加通道卡片自动一致。
  sp?.variable?.('channel_routing_card', () => renderRoutingCard())

  // 通道健康面接线(issue #107/#108):检索通道 verdict → 会话状态标记 +
  // down/cooldown 事件落持久面(doctor CLI 进程消费)。落盘失败不阻塞检索。
  const noteChannel = async (channel: string, verdict: string): Promise<void> => {
    const ev = noteChannelVerdict(channel, verdict)
    if (ev) await recordChannelEvent(config.stateRoot ?? '.', ev)
  }
  /** verdict≠hit 时在平铺 envelope 上追加 routing 建议(§3.3:失败现场教学) */
  const routingField = (intent: ChannelIntent, excludeChannel: string) =>
    ({ routing: routingAdvice(intent, { excludeChannel }) })

  // D-NEW 进程护栏(Z3 WASM crash 教训):dsh 0.1.1-rc.1 缺 uncaughtException
  // handler,插件异常穿透即杀进程。我们在 gotry 侧挂护栏:同步 fsync 写事故证据
  // (gotry-state/incidents.jsonl),handler 自身不再抛,不阻塞后续控制流。
  // 不调 process.exit——让 dsh/上级容器决定生死,我们只留现场。
  installProcessGuards(config.stateRoot ?? '.', { uncaughtException: 'gotry-tools', unhandledRejection: 'gotry-tools' })

  // 账号会话授权闸(RFC 支柱④「用户明示授权 + 站点白名单 + 随时可关」进代码;v2 每会话一次):
  // 会话面工具动用用户本人登录态,**每会话每站点首次调用**弹 dsh 原生审批卡——
  // allowed-once 记入会话 granted 集,后续同站调用免弹;用户拒绝 = 本会话吊销
  // (denied 集,不再弹卡也不再执行——拒绝是裁决,不反复骚扰);无审批通道
  // (headless 无用户在场)一律 fail-closed 拒绝。sessionAccess: ask(默认)|allow|off。
  // v1 教训(2026-08-29 founder 实测「每次都要弹,经常无法点击」):逐调用弹卡 = 骚扰,
  // 会话态收归 capabilities/session-consent.ts。防御:极简宿主/mock ctx 无事件总线时跳过。
  const ctxOn = (ctx as unknown as { on?: unknown }).on
  if (typeof ctxOn === 'function') {
    ctx.on('tools/pre-execute', createConsentGate({
      access: () => config.sessionAccess ?? 'ask',
      approval: approvalFromContext(ctx),
    }))
  }

  // LLM_MODEL → dsh 会话面模型覆盖(issue #77;机制与分层见
  // capabilities/model-override.ts 头注)。GOTRY_LLM_MODEL 未设时零行为变化。
  installModelOverride(ctx as unknown as Parameters<typeof installModelOverride>[0])

  // D-NEW 收尾:全部工具 execute 统一异常隔离——单个工具抛错/拒绝不再沿 cordis
  // 传到 dsh 主循环,降级为结构化错误返回给 LLM + incident 落盘(incident-log.ts)。
  const registerGuarded = (tool: ReturnType<typeof defineTool>): void => {
    const t = { ...(tool as unknown as Record<string, unknown>) }
    if (typeof t.execute === 'function') {
      t.execute = guardToolExecute(String(t.name), config.stateRoot ?? '.', t.execute as (args: never, exec: unknown) => never)
    }
    ctx.tools.register(t as unknown as ReturnType<typeof defineTool>)
  }

  registerGuarded(defineTool({
    name: 'gotry_feasibility_check',
    description:
      'Check travel candidates against the user\'s motivation and hard constraints using the '
      + 'door-to-door true-cost engine (wake time, arrival state, energy, usable hours, money). '
      + 'Input is the structured request (motivation weights + hard constraints + window + budget + home hubs) '
      + 'and the candidate list (services/transfers/stay costs/min days): '
      + 'structure { request: { motivation weights, hard constraints, window, budget, home hubs }, candidates: [ { id, label, services, transfers, stay, minDays } ] }. '
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
      return { ok: true, ...result, latency_ms: Date.now() - started, via: 'in-process-unified' }
    },
    presentCall: args => ({ card: 'generic', title: 'GoTry 可行性检查(门到门全成本)', kind: 'execute', rawInput: args.payload }),
    presentResult: (args, value) => {
      // D-4 卡片赎回:结果卡不再是裸 JSON —— 逐候选判定 + 全成本 vs 预算紧凑行 + 人话答案
      const r = value as FeasibilityResult
      const budget = ((args.payload as { request?: { budget_cny?: number } })?.request)?.budget_cny
      const lines = (r.verdicts ?? []).map(v => {
        const tc = (v.true_cost ?? {}) as { money_cny?: number }
        const money = typeof tc.money_cny === 'number'
          ? ` ¥${tc.money_cny}/人` + (typeof budget === 'number' ? `(预算 ¥${budget},${tc.money_cny <= budget ? '余' : '超'} ¥${Math.abs(budget - tc.money_cny)})` : '')
          : ''
        return v.feasible
          ? `✅ ${String(v.name ?? v.candidate_id)}${money}${v.candidate_id === r.recommended ? ' ← 推荐' : ''}`
          : `❌ ${String(v.name ?? v.candidate_id)} — ${(Array.isArray(v.unsat_core) ? v.unsat_core.join(',') : '不可行')}`
      })
      return {
        card: 'generic',
        title: `可行性:${r.recommended ? `推荐 ${r.recommended}` : '全部不可行'}`,
        content: [{ type: 'text', text: (lines.length ? lines.join('\n') + '\n\n' : '') + String(r.answer_md ?? '').slice(0, 1500) }],
      }
    },
  }))

  registerGuarded(defineTool({
    name: 'gotry_motivation_save',
    description:
      'Persist the traveler\'s motivation profile (the "why depart" contract object). '
      + 'This is the B2B reuse seam: downstream plugins consume only MotivationProfile + constraints, '
      + 'never the principal/sponsor distinction. MERGE semantics (T1): call again with just the NEW '
      + 'facts learned this turn (weights delta optional but MUST bring fresh evidence; evidence = user quotes); '
      + 'existing history is never deleted. Requires evidence on every call (P0 anti-fabrication rule).',
    parameters: {
      profile: {
        type: 'json',
        required: true,
        description: '{ weights: {escape_rest: 0.7, ...}, evidence: [user quotes...], hard: {wake_not_before, min_arrival_energy_pct} }',
      },
    },
    output: {
      // loose json:guard 兜底字段(ok/summary)不被 strict schema 拒(骨架事故同款)
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: `动机画像已保存:${String((value as { path?: string }).path ?? '')}` }],
    },
    async execute(args: { profile: unknown }, _exec: unknown) {
      // T1 接线:本工具是增量补丁语义(契约 18——模型每轮把对话新事实带进来),
      // 经 mergeProfile 守门合并进既有画像(追加不删史/幂等/权重变更须伴新证据),
      // 不再整档覆盖。首次调用(无档案)= 全量建立。
      // ADR-15:守门+事件+投影在账本单事务内完成,evidence 红线拒绝即回滚,账本无痕。
      const incoming = (args.profile ?? {}) as { weights?: Record<string, number>; evidence?: string[]; hard?: Record<string, unknown> }
      if (!incoming.evidence?.length) {
        throw new Error('refusing to save a motivation profile without evidence (P0 anti-fabrication rule)')
      }
      const ledger = ensureLedger(config.stateRoot)
      const res = ledger.appendMotivationPatch({ weights: incoming.weights, evidence: incoming.evidence, hard: incoming.hard })
      const profileJson = JSON.parse(JSON.stringify(res.profile)) as JsonObject
      return res.saved
        ? { ok: true, saved: true, path: ledger.dbPath, profile: profileJson, summary: '画像已合并入账本(单事务)' }
        : { ok: true, saved: false, path: ledger.dbPath, profile: profileJson, summary: '无新内容(幂等跳过)' }
    },
    presentCall: args => ({ card: 'generic', title: '保存动机画像', kind: 'edit', rawInput: args.profile }),
  }))

  registerGuarded(defineTool({
    name: 'gotry_wish_pool_add',
    description:
      'Add an aspiration to the "next departure" wish pool — the graceful home for infeasible dreams. '
      + 'An entry carries its fulfilment conditions (days needed, budget, best months) so a future '
      + '"next departure" nudge can fire when the window matches. Each entry gets a stable wish_id '
      + '(the memory-utility sidecar keys on it); muted:true puts a wish dormant (永不删除,只是不再召回). 憧憬不被拒绝。',
    parameters: {
      entry: {
        type: 'json',
        required: true,
        description: '{ name, reason?, conditions: { days, budget_cny, best_months }, muted?: boolean }',
      },
    },
    output: {
      // loose json:guard 兜底字段(ok/summary)不被 strict schema 拒(骨架事故同款)
      schema: { type: 'json' },
      render: (_args, value) => {
        const v = value as { total?: number; path?: string }
        return [{ type: 'text', text: `已加入「下一次出发」清单(共 ${v.total ?? '?'} 项):${v.path ?? ''}` }]
      },
    },
    async execute(args: { entry: unknown }, _exec: unknown) {
      const entry = (args.entry ?? {}) as WishPoolEntryInput & { muted?: boolean }
      // 同名憧憬幂等更新(刷新理由与成行条件),不重复入池;wish_id 语义派生自名称,稳定可重放。
      // ADR-15:conditions 红线在账本事务内校验拒绝。
      const ledger = ensureLedger(config.stateRoot)
      const r = ledger.appendWish({ name: entry.name, reason: entry.reason, conditions: entry.conditions, muted: entry.muted })
      return { ok: true, added: r.added, wish_id: r.wish_id, total: r.total, path: ledger.dbPath }
    },
    presentCall: args => ({ card: 'generic', title: '加入「下一次出发」清单', kind: 'edit', rawInput: args.entry }),
  }))

  registerGuarded(defineTool({
    name: 'gotry_wish_pool_list',
    description:
      'Surface AT MOST ONE "next departure" wish whose fulfilment conditions match the user\'s current window '
      + '(0..1 rule: never more than one nudge per turn, never push when nothing matches — 憧憬不被拒绝,也不被硬推). '
      + 'Muted wishes never surface. Surfacing records a recalled event in the memory-utility sidecar. '
      + 'action="confirm-outcome" records the user-confirmed real-world outcome (attribution helpful/harmful/neutral) — '
      + 'ONLY pass attribution the user explicitly stated; the agent must never self-attribute usefulness.',
    parameters: {
      query: {
        type: 'json',
        required: true,
        description: '{ action?: "recall"|"confirm-outcome", days?, budgetCny?, month?, wishId?, attribution?: "helpful"|"harmful"|"neutral", detail?, tripStart?: "行程起始(确认成行时挂时间线)" }',
      },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: String((value as { summary?: string }).summary ?? '') }],
    },
    async execute(args: { query: unknown }, _exec: unknown) {
      const q = unwrapQuery<{ action?: string; days?: number; budgetCny?: number; month?: number; wishId?: string; attribution?: 'helpful' | 'harmful' | 'neutral'; detail?: string; tripStart?: string }>(args, 'action')
      const ledger = ensureLedger(config.stateRoot)
      const now = new Date().toISOString()
      if (q.action === 'confirm-outcome') {
        if (!q.wishId || !q.attribution) {
          return { ok: false, summary: 'confirm-outcome 需要 wishId + attribution(helpful|harmful|neutral)' } as never
        }
        // 成行确认 = 效用事件 + 可选时间线行程,账本单事务(ADR-15:原两文件写在崩溃时分叉)
        let tripInput: { destination: string; start: string; end?: string; companions?: string[]; source: 'wish-confirmed'; evidence: string } | undefined
        const wish = ledger.readWishPool().find(e => String(e.wish_id) === q.wishId) as { name?: unknown } | undefined
        if (q.tripStart && wish?.name) {
          const anchor = buildTimeAnchor(new Date())
          const start = resolveTimelineDate(q.tripStart, anchor) ?? (/^\d{4}-\d{2}-\d{2}$/.test(q.tripStart) ? q.tripStart : undefined)
          if (start) {
            tripInput = {
              destination: String(wish.name), start, companions: undefined,
              source: 'wish-confirmed', evidence: `wish ${q.wishId} confirm-outcome(${q.attribution})`,
            }
          }
        }
        const r = ledger.confirmOutcome({ wishId: q.wishId, attribution: q.attribution, detail: q.detail, trip: tripInput })
        return { ok: true, recorded: r.recorded, wish_id: q.wishId, status: q.attribution, ...(r.trip ? { trip: r.trip } : {}) } as never
      }
      // recall:0..1 条件匹配(判定归 wish-pool 纯函数),muted 永不召回,无命中不硬推
      const pool = ledger.readWishPool()
      const candidates = pool.filter(e => !e.muted && typeof e.wish_id === 'string')
      const month = q.month ?? new Date().getMonth() + 1
      const match = pickNudgeWish(candidates as WishPoolEntry[], { days: q.days, budgetCny: q.budgetCny, month })
      if (!match) {
        return { ok: true, suggestion: null, summary: `无可成行的憧憬匹配当前窗口(${candidates.length} 条在册,0..1 纪律:不硬推)` } as never
      }
      const { events: next } = ledger.appendUtilityEvent({
        wish_id: match.wishId, kind: 'recalled', ts: now, ctx: 'gotry_wish_pool_list.recall',
      })
      const utility = projectUtility(next)[match.wishId]
      return {
        ok: true,
        suggestion: { wish_id: match.entry['wish_id'], name: match.entry['name'], reason: match.entry['reason'], conditions: match.entry['conditions'], match_score: match.score, hits: match.hits },
        utility: { status: utility?.status ?? 'unknown', recalled: utility?.recalled ?? 1 },
        summary: `「下一次出发」候选(0..1):${String(match.entry['name'])}——成行条件 ${JSON.stringify(match.entry['conditions'])},本次窗口命中 ${match.score}/3 项(${match.hits.join('+')});效用状态 ${utility?.status ?? 'unknown'}`,
      } as never
    },
    presentCall: args => ({ card: 'generic', title: '「下一次出发」召回', kind: 'search', rawInput: args.query }),
  }))

  // ADR-24 v2 复访交付面:用户回问「行程规划好了吗」时,模型用这个只读工具
  // 查后台工单状态;settled 附交付物摘录(完整内容在工单同目录
  // .deliverable.md)。工单由 scripts/turn-handoff-collect.ts 收集结算。
  registerGuarded(defineTool({
    name: 'gotry_turn_handoff_list',
    description:
      'List background deep-planning handoff tickets (read-only). Call this whenever the user asks about '
      + 'a previously handed-off plan («规划好了吗» / «上次那个行程»): open = still being worked in the '
      + 'background (ETA ' + '约 1 小时' + '), settled = deliverable ready (excerpt included, full text in the '
      + 'ticket\'s .deliverable.md), failed = honest failure note. Never fabricate a deliverable that is not here.',
    // D-30 第三刀(issue #112):query blob → 平铺 typed;全字段可选 → interpretArgs 容忍层(同 session 刀法)
    parameters: {
      ticketId: { type: 'string', description: '只看这一单,如 th-...(缺省列全部)' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: String((value as { summary?: string }).summary ?? '') }],
    },
    async execute(args, _exec: unknown) {
      const q = interpretArgs<{ ticketId?: string }>(args)
      const root = process.env.GOTRY_TURN_HANDOFF_ROOT ?? config.stateRoot ?? '.'
      const all = await listTurnHandoffTickets(root)
      const tickets = (q.ticketId ? all.filter(t => t.id === q.ticketId) : all).slice(0, 10)
      if (tickets.length === 0) {
        return {
          ok: true, count: 0,
          summary: q.ticketId
            ? `没有 id 为 ${q.ticketId} 的后台规划工单(可能已被清理或记错 id)`
            : '当前没有后台深度规划工单(无挂起、无历史)',
        } as never
      }
      const lines = tickets.map(t => {
        const head = `[${t.status}] ${t.id} ${t.objective.slice(0, 40)}`
        if (t.status === 'open') return `${head}——后台规划中,ETA ${t.etaLabel}`
        if (t.status === 'failed') return `${head}——失败:${t.error ?? '未知原因'}(请重新发起规划)`
        return `${head}——已交付,摘要:${(t.deliverableExcerpt ?? '').slice(0, 120).replace(/\n/g, ' ')}`
      })
      return {
        ok: true, count: tickets.length, tickets,
        summary: `后台规划工单 ${tickets.length} 张:\n${lines.join('\n')}`,
      } as never
    },
    presentCall: args => ({ card: 'generic', title: '后台规划工单查询', kind: 'search', rawInput: args }),
  }))

  registerGuarded(defineTool({
    name: 'gotry_companion_save',
    description:
      'Save/update a travel companion profile (memory-design M5 layer): constraints that shape itinerary STRUCTURE and ranking — '
      + 'never a hard filter (「爸爸65轻度高血压」→ 不排高海拔/控制步行量;「晕车」→ 优先火车/备提示). '
      + 'evidence MUST be the user\'s verbatim words (append-only, traceable). '
      + 'NEGATIVE LIST: passport/ID/phone numbers are rejected on sight — such fields never enter storage.',
    parameters: {
      companion: {
        type: 'json',
        required: true,
        description: '{ label: "爸爸", constraints: { mobility?: "步行≤4h", health?: ["轻度高血压"], prefs?: ["怕吵"] }, evidence: "<用户原话>" }',
      },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: String((value as { summary?: string }).summary ?? '') }],
    },
    async execute(args: { companion: unknown }, _exec: unknown) {
      const c = (args.companion ?? {}) as { label?: string; constraints?: { mobility?: string; health?: string[]; prefs?: string[] }; evidence?: string }
      if (!c.evidence) return { ok: false, summary: 'evidence 必填(用户原话,溯源 P0)' } as never
      // ADR-15:负面清单守卫(upsertCompanion)在账本事务内执行,拒收即回滚
      const ledger = ensureLedger(config.stateRoot)
      const res = ledger.appendCompanion({
        label: String(c.label ?? ''),
        constraints: { mobility: c.constraints?.mobility, health: c.constraints?.health, prefs: c.constraints?.prefs },
        evidence: c.evidence,
      })
      if (!res.appended && res.reason) return { ok: false, summary: res.reason } as never
      return { ok: true, appended: res.appended, companion_id: res.companionId, total: res.total, summary: res.appended ? `同行人已保存:${res.companionId}` : `无新内容(幂等跳过):${res.companionId}` } as never
    },
    presentCall: args => ({ card: 'generic', title: '保存同行人', kind: 'edit', rawInput: args.companion }),
  }))

  registerGuarded(defineTool({
    name: 'gotry_trip_log',
    description:
      'Record a PAST trip into the travel timeline (memory-design M4 layer). Use when the user mentions a trip they already took '
      + '(「去年国庆去了大理」) — dates resolve via the time anchor (词表外日期会拒绝,请用户给绝对日期), evidence MUST be the user\'s verbatim words. '
      + 'Append-only and idempotent (same destination+start+source = same trip); overlapping same-destination trips are rejected for human adjudication. '
      + 'Past trips power origin resolution and 「去过不再推」 ranking — never a hard filter.',
    parameters: {
      query: {
        type: 'json',
        required: true,
        description: '{ destination: "大理", start: "2025-10-01 或绝对日期表达", end?: 同上, companions?: ["爸爸"], evidence: "<用户原话>" }',
      },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: String((value as { summary?: string }).summary ?? '') }],
    },
    async execute(args: { query: unknown }, _exec: unknown) {
      const q = unwrapQuery<{ destination?: string; start?: string; end?: string; companions?: string[]; evidence?: string }>(args, 'destination')
      if (!q.destination) return { ok: false, summary: 'destination 必填' } as never
      if (!q.evidence) return { ok: false, summary: 'evidence 必填(用户原话,溯源 P0)' } as never
      const anchor = buildTimeAnchor(new Date())
      const start = resolveTimelineDate(q.start ?? '', anchor) ?? (/^\d{4}-\d{2}-\d{2}$/.test(q.start ?? '') ? q.start : undefined)
      if (!start) return { ok: false, summary: `start 无法解析为绝对日期(${q.start ?? '缺'})——请向用户要具体日期,不猜` } as never
      const end = q.end ? (resolveTimelineDate(q.end, anchor) ?? (/^\d{4}-\d{2}-\d{2}$/.test(q.end) ? q.end : undefined)) : undefined
      // ADR-15:appendTrip 守门(必填/绝对日期/重叠冲突即停)在账本事务内执行
      const ledger = ensureLedger(config.stateRoot)
      const res = ledger.appendTripEvent({
        destination: q.destination.trim(), start, end, companions: q.companions,
        source: 'user-verbatim', evidence: q.evidence,
      })
      if (!res.appended && res.reason) return { ok: false, summary: res.reason } as never
      return { ok: true, appended: res.appended, trip_id: res.tripId, total: res.total, summary: res.appended ? `已入时间线:${q.destination} @ ${start}` : `已存在(幂等跳过):${res.tripId}` } as never
    },
    presentCall: args => ({ card: 'generic', title: '记录旅行', kind: 'edit', rawInput: args.query }),
  }))

  registerGuarded(defineTool({
    name: 'gotry_hotel_search',
    description:
      'Search hotels via hotelbyte-cli (real-time when hbcli credentials exist, falls back to the static pack with explicit evidence tagging). '
      + 'Input: destination city name + optional dates/adults. Dates accept verbatim natural expressions (下周五 / 8.20 / 下周五+3) — '
      + 'the code layer resolves them against the time anchor; unresolved expressions degrade to an undated search with an explicit '
      + 'date_notes entry instead of guessing. Output: hotel list with evidence chain ([realtime-API:hbcli] + fetch timestamp, '
      + 'or [static-pack:estimate]) per the L4 invariant.',
    // D-30 第二刀(issue #112):query blob → 平铺 typed 契约(同 flyai 刀法)。
    parameters: {
      destination: { type: 'string', required: true, description: '目的地城市,如 大理' },
      checkIn: { type: 'string', description: '入住日:YYYY-MM-DD 或自然表达(下周五/8.20/下周五+3);解析不了降级无日期检索并记 date_notes' },
      checkOut: { type: 'string', description: 'checkOut 退房日:YYYY-MM-DD 或自然表达,形态同 checkIn' },
      adults: { type: 'integer', description: '成人数(顶层字段,默认 2)' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: String((value as { summary?: string }).summary ?? JSON.stringify(value).slice(0, 400)) }],
    },
    async execute(args, _exec) {
      const q = args
      if (!q.destination) throw new Error('gotry_hotel_search requires destination')
      const started = Date.now()
      const fallbackPath = join(import.meta.dirname, '..', '..', 'data', 'hotels_2026.json')
      // D-10 切片 B:日期槽位接受逐字自然表达(下周五/8.20/+N),代码层换算(slot-spec);
      // unresolved 不猜——降级为无日期搜索并显式记 note,由模型向用户追问
      const anchor = buildTimeAnchor(new Date())
      const dateNotes: string[] = []
      const resolveDate = (expr?: string): string | undefined => {
        if (!expr) return undefined
        const r = resolveSlotDate(expr, anchor)
        if (!r.date) {
          dateNotes.push(`日期未解析:${r.raw}——请向用户确认具体日期`)
          return undefined
        }
        if (r.raw !== r.date) dateNotes.push(`slot-resolved: ${r.raw} → ${r.date}`)
        return r.date
      }
      // 效应解译层(ADR-18):渠道选择/韧性(重试/熔断)在解译器,result 原样透传——
      // 断路拒绝时返回平铺失败面(不发起查询,不伪装成 miss)
      const itp = await interpretEffect({
        effect: 'HBCLI_HOTEL_SEARCH',
        params: { destination: q.destination, checkIn: resolveDate(q.checkIn), checkOut: resolveDate(q.checkOut), adults: q.adults, hbcliBin: config.hbcliBin, timeoutMs: config.timeoutMs, fallbackPath },
      })
      if (!itp.result) return declinedObservation('HBCLI_HOTEL_SEARCH', itp.trace)
      const resp = itp.result
      const dir = await ensureStateDir(config.stateRoot)
      const isLive = resp.via === 'hbcli-realtime'
      const evidence = isLive ? resp.evidence : '[静态包:估算]'
      await recordLatency(join(dir, 'bridge-latency.jsonl'), Date.now() - started, `hotel_search:${resp.via}`).catch(() => {})
      const payload = {
        ok: true,
        hotels: resp.hotels ?? null,
        evidence,
        destination: q.destination,
        via: resp.via,
        latency_ms: Date.now() - started,
        summary: resp.summary,
        error: resp.error,
        ...(dateNotes.length ? { date_notes: dateNotes } : {}),
      } as never
      return JSON.parse(JSON.stringify(payload)) as never
    },
    presentCall: args => ({ card: 'generic', title: `酒店搜索:${args.destination ?? ''}`, kind: 'search', rawInput: args }),
    presentResult: (_args, value) => {
      const r = value as { hotels?: unknown; via?: string; destination?: string; summary?: string }
      const h = r.hotels
      const liveCount = Array.isArray(h) ? h.length : 0
      // 静态包是 {meta, stays} 对象而非数组(issue #24:此前计数恒 0 → UI 显示「无结果」)
      const stays = !Array.isArray(h) && h && typeof h === 'object' ? (h as { stays?: unknown[] }).stays : undefined
      const staticCount = Array.isArray(stays) ? stays.length : 0
      const tag = r.via === 'hbcli-realtime'
        ? (liveCount ? `实时 ${liveCount} 家` : '实时')
        : staticCount ? `静态包 ${staticCount} 块` : (liveCount ? `${liveCount} 家` : '无结果')
      return {
        card: 'generic',
        title: `酒店:${r.destination ?? ''} ${tag}`,
        content: [{ type: 'text', text: String(r.summary ?? '') }],
      }
    },
  }))

  registerGuarded(defineTool({
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
      // loose json(与兄弟工具一致):strict additionalProperties:false 会拒 guard 的
      // 错误兜底字段(ok/summary),校验错掩盖真实错误
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: String((value as { evidence?: string }).evidence ?? JSON.stringify(value)) }],
    },
    async execute(args: { from?: string; to?: string; query?: unknown } & Record<string, unknown>, _exec: unknown) {
      // 平铺参数的工具也会被 LLM 包进 query(#12/#13 同款形态),unwrapQuery 兜住
      const q = unwrapQuery<{ from?: string; to?: string }>(args)
      const verdict = await checkConnectivity(String(q.from ?? ''), String(q.to ?? ''))
      return JSON.parse(JSON.stringify({ ok: true, ...verdict })) as Record<string, never>
    },
    presentCall: args => ({ card: 'generic', title: `骨架校验:${args.from}-${args.to}`, kind: 'execute', rawInput: args }),
  }))

  registerGuarded(defineTool({
    name: 'gotry_weather_check',
    description:
      'Check weather for a destination: forecast (≤16 days) or historical climate (seasonality baseline). '
      + 'Free Open-Meteo API, no key required. Input: place name (Chinese ok) or lat/lng. '
      + 'Returns daily temp range, precipitation probability, weather code — with evidence chain tagging '
      + '[实时API:open-meteo@ts]. Use to ground seasonal advice in real data instead of LLM guessing.',
    parameters: {
      // D-30 第二刀(issue #112):query blob → 平铺 typed 契约(同 flyai 刀法)。
      place: { type: 'string', description: '城市名(中文可),如 大理;与 lat/lng 二选一,都没给 execute 结构化报错' },
      lat: { type: 'number', description: '纬度(与 lng 成对;给了则跳过地理编码)' },
      lng: { type: 'number', description: '经度(与 lat 成对)' },
      month: { type: 'integer', description: '气候基线月份 1-12(mode=climate 或给了 month 未指 mode 时用)' },
      mode: { type: 'string', enum: ['forecast', 'climate'], description: '默认 forecast' },
      days: { type: 'integer', description: '预报天数(≤16,默认 7)' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: String((value as { summary?: string }).summary ?? JSON.stringify(value).slice(0, 600)) }],
    },
    async execute(args, _exec) {
      const q = args
      const started = Date.now()
      let lat: number | undefined = q.lat, lng: number | undefined = q.lng
      let placeLabel = q.place ?? `${q.lat},${q.lng}`
      if (lat === undefined || lng === undefined) {
        if (!q.place) throw new Error('gotry_weather_check requires place name or lat/lng')
        const geoItp = await interpretEffect({ effect: 'WEATHER_GEOCODE', params: { name: q.place } })
        if (!geoItp.result) return declinedObservation('WEATHER_GEOCODE', geoItp.trace)
        const geo = geoItp.result
        if (!geo.ok || geo.results.length === 0) {
          return JSON.parse(JSON.stringify({ ok: false, summary: `地点「${q.place}」地理编码失败:${geo.error ?? '无结果'}`, evidence: geo.evidence })) as Record<string, never>
        }
        const hit = geo.results[0]
        lat = hit.latitude; lng = hit.longitude
        placeLabel = `${hit.name}(${hit.admin1 ?? hit.country ?? ''})`
      }
      const isClimate = q.mode === 'climate' || (q.month !== undefined && q.mode !== 'forecast')
      const wxItp = isClimate
        ? await interpretEffect({ effect: 'WEATHER_CLIMATE', params: { latitude: lat, longitude: lng, month: q.month ?? new Date().getMonth() + 1 } })
        : await interpretEffect({ effect: 'WEATHER_FORECAST', params: { latitude: lat, longitude: lng, days: q.days } })
      if (!wxItp.result) return declinedObservation(isClimate ? 'WEATHER_CLIMATE' : 'WEATHER_FORECAST', wxItp.trace)
      const r = wxItp.result
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
    presentCall: args => ({ card: 'generic', title: `天气:${args.place ?? `${args.lat ?? ''},${args.lng ?? ''}`}`, kind: 'fetch', rawInput: args }),
    presentResult: (args, value) => {
      const r = value as { summary?: string }
      const place = String(args.place ?? '')
      const failed = String(r.summary ?? '').includes('降级') || String(r.summary ?? '').includes('unavailable')
      return {
        card: 'generic',
        title: `天气:${place} ${failed ? '降级' : 'ok'}`,
        content: [{ type: 'text', text: String(r.summary ?? '') }],
      }
    },
  }))

  registerGuarded(defineTool({
    name: 'gotry_flight_verify',
    description:
      'Verify whether a flight callsign is currently observable on the OpenSky ADS-B network. '
      + 'Free anonymous API (~400 credits/day, 4 req/s burst). Three-valued semantics: '
      + 'observed = strong positive (the aircraft is currently being broadcast); '
      + 'not_observed = no conclusion (ADS-B coverage is limited by geography/altitude — '
      + 'a missing signal does NOT disprove the flight); '
      + 'unavailable = API failure, gracefully degraded. '
      + 'Use to ground "is this flight actually flying right now?" in real data, complementing '
      + 'the OpenFlights skeleton (historical connectivity) and the static flight pack (planned schedule).',
    parameters: {
      query: {
        type: 'json',
        required: true,
        description: '{ callsign: "EK329", airport?: "OMDB", timeoutMs?: 10000 }',
      },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: String((value as { summary?: string }).summary ?? JSON.stringify(value).slice(0, 500)) }],
    },
    async execute(args: { query: unknown }, _exec: unknown) {
      const q = unwrapQuery<{ callsign: string; airport?: string; timeoutMs?: number }>(args, 'callsign')
      const started = Date.now()
      if (!q.callsign) {
        return JSON.parse(JSON.stringify({ verdict: 'unavailable', evidence: '[校验不可用:无 callsign]', summary: 'callsign 必填' })) as Record<string, never>
      }
      const itp = await interpretEffect({ effect: 'OPENSKY_FLIGHT_VERIFY', params: { callsign: q.callsign, airport: q.airport, timeoutMs: q.timeoutMs } })
      if (!itp.result) return declinedObservation('OPENSKY_FLIGHT_VERIFY', itp.trace)
      const r = itp.result
      const dir = await ensureStateDir(config.stateRoot)
      await recordLatency(join(dir, 'bridge-latency.jsonl'), Date.now() - started, `flight_verify:${r.via}`).catch(() => {})
      const summary = r.verdict === 'observed'
        ? `${r.callsign} 当前 ADS-B 观测命中 (${r.hits?.length ?? 0} 架)${r.airport ? ` 在 ${r.airport}` : ''}\n${r.evidence}`
        : r.verdict === 'not_observed'
          ? `${r.callsign} 当前观测列表未见(ADS-B 覆盖有限,不否定该航班存在)\n${r.evidence}`
          : `${r.callsign} OpenSky 不可用:${r.error}\n${r.evidence}`
      return JSON.parse(JSON.stringify({
        ok: true,
        verdict: r.verdict, callsign: r.callsign, airport: r.airport,
        sample_size: r.sampleSize, hits: r.hits, evidence: r.evidence, summary,
        latency_ms: Date.now() - started,
      })) as Record<string, never>
    },
    presentCall: args => ({ card: 'generic', title: `飞行校验:${String((args.query as { callsign?: string })?.callsign ?? '')}`, kind: 'fetch', rawInput: args.query }),
  }))

  registerGuarded(defineTool({
    name: 'gotry_flyai_search',
    description:
      'Live travel search through the Fliggy official FlyAI channel (read-only, no key; booking/comparison happens by the HUMAN on the jumpUrl page). '
      + 'kind="flight"|"train": from/to 中文城市名 + date YYYY-MM-DD — real schedules & prices, split 直达/中转 in results. '
      + 'kind="hotel": to=目的地中文(如 大理), checkIn/checkOut (YYYY-MM-DD,成对可选——未定档期可不填先摸底), keyWords?. '
      + 'Hotel prices may be masked upstream (priceRaw like "¥7xx"): always present the mask as a range, and let the human open jumpUrl for the real price. '
      + 'Evidence [实时API:flyai@ts]. verdict=needs-setup (anonymous trial quota exhausted, upstream 429) is a CONFIG issue, not a search failure: surface the setup hint once, do NOT retry this tool this session — switch to gotry_session_search or web search. '
      + 'Errors (rate-limit Sentinel / invalid dates) degrade as structured errors with the upstream message — surface them, never guess.',
    // D-30 第一刀(issue #112):query json blob → 平铺 typed 契约。逐字段 schema 由 dsh
    // parameterSchemaSpecToJsonSchema 投影为模型可见 JSON Schema,validateArgs 在 execute 前
    // 宿主权校验——畸形参数(缺 kind/枚举外值/类型错/legacy blob 包裹)在入口即被结构化拒绝
    // (ToolArgsError → guardToolExecute 兜成 ADR-13 ToolFailure,形状由迁移测试锁死)。
    // 条件必填(机/火要 from/to/date,酒店要 to)不在 schema 强制,仍由 execute 结构化报错给方向。
    parameters: {
      kind: { type: 'string', enum: ['flight', 'train', 'hotel'], required: true, description: '检索类型:flight 机票 / train 火车 / hotel 酒店' },
      from: { type: 'string', description: '出发城市中文,如 上海——kind=flight|train 必填' },
      to: { type: 'string', description: '到达城市中文,如 丽江;kind=hotel 时为目的地,如 大理(必填)' },
      date: { type: 'string', description: '出发日期 YYYY-MM-DD——kind=flight|train 必填,须为今天或未来' },
      checkIn: { type: 'string', description: '入住日期 YYYY-MM-DD,仅 kind=hotel;与 checkOut 成对可选(未定档期可不填先摸底)' },
      checkOut: { type: 'string', description: '退房日期 YYYY-MM-DD,仅 kind=hotel;与 checkIn 成对' },
      keyWords: { type: 'string', description: '酒店关键词,如 洱海——仅 kind=hotel 可选' },
    },
    output: { schema: { type: 'json' }, render: (_a, v) => [{ type: 'text', text: String((v as { summary?: string }).summary ?? JSON.stringify(v).slice(0, 600)) }] },
    async execute(args, _exec) {
      const q = args
      if (q.kind === 'hotel') {
        const dest = (q.to ?? '').trim()
        if (!dest) return { ok: false, summary: 'kind=hotel 需要 to(目的地中文,如 大理)' } as const
        if ((q.checkIn ? 1 : 0) !== (q.checkOut ? 1 : 0) || (q.checkIn && !/^\d{4}-\d{2}-\d{2}$/.test(q.checkIn))) {
          return { ok: false, summary: '酒店 checkIn/checkOut 须成对且为 YYYY-MM-DD(未定档期可不填,先摸底)' } as const
        }
        // 过去入住日同机/火过去日期闸(issue #24 同构;分层纪律:日期算术在代码层)
        if (q.checkIn) {
          const now = new Date()
          const todayYmd = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
          if (q.checkIn < todayYmd || (q.checkOut ?? '') < q.checkIn) {
            return JSON.parse(JSON.stringify({
              ok: false, verdict: 'error', kind: 'hotel',
              summary: `未发起查询:入住 ${q.checkIn}/退房 ${q.checkOut ?? ''} 不是未来合法区间(今天 ${todayYmd})。向用户确认日期后再查。`,
            })) as Record<string, never>
          }
          if ((q.checkOut ?? '').length !== 10) {
            return { ok: false, summary: 'checkOut 需 YYYY-MM-DD(与 checkIn 成对)' } as const
          }
        }
        const itp = await interpretEffect({ effect: 'FLYAI_SEARCH', params: { kind: 'hotel', destName: dest, checkInDate: q.checkIn, checkOutDate: q.checkOut, keyWords: q.keyWords } })
        if (!itp.result) return declinedObservation('FLYAI_SEARCH', itp.trace)
        const r = itp.result
        await noteChannel('flyai', r.verdict)
        const top = (r.hotels ?? []).slice(0, 8).map(o => `${o.name}${o.star ? `(${o.star})` : ''} ${o.priceRaw ?? '价待询'}${o.poi ? ` · ${o.poi}` : ''}`)
        const summary = r.verdict === 'hit'
          ? `${dest} 酒店(飞猪官方只读)前 ${top.length} 家(价格多为打码,真实价以 jumpUrl 为准):\n${top.join('\n')}\n${r.evidence}`
          : r.verdict === 'needs-setup'
            ? `${dest} 酒店检索未发起(配置问题,非检索失败):${r.error ?? ''}\n${r.setup ?? ''}\n状态体检可调 gotry_doctor。${r.evidence}`
            : `${dest} 酒店无结果或失败:${r.error ?? 'miss'} ${r.evidence}`
        return JSON.parse(JSON.stringify({ ...r, summary, ...(r.verdict !== 'hit' ? routingField('search-hotel', 'flyai') : {}) })) as Record<string, never>
      }
      const kind = q.kind === 'train' ? 'train' : 'flight'
      if (!q.from || !q.to || !q.date) {
        return { ok: false, summary: '需要 from/to(中文城市名)与 date(YYYY-MM-DD)' } as const
      }
      // 过去日期预校验(issue #24,代码层算术;分层纪律):用户说「7.18」未带年份时模型会落到当前年,
      // 而今天可能已在 8 月——过去日期上游必拒(「出发日期非法」)。拦在发查询之前并指明修正方向,
      // 不让模型从 miss 里猜因。
      const now = new Date()
      const todayYmd = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
      if (q.date < todayYmd) {
        return JSON.parse(JSON.stringify({
          ok: false, verdict: 'error', kind,
          summary: `未发起查询:日期 ${q.date} 已是过去(今天 ${todayYmd}),过去不存在在售机/火车票。`
            + `多为用户时间表达未带年份所致——向用户确认年份(或按未来最近的同月日修正)后再查。`,
        })) as Record<string, never>
      }
      const itp = await interpretEffect({ effect: 'FLYAI_SEARCH', params: { kind, origin: q.from, destination: q.to, depDate: q.date } })
      if (!itp.result) return declinedObservation('FLYAI_SEARCH', itp.trace)
      const r = itp.result
      await noteChannel('flyai', r.verdict)
      // issue #46 事实落账(ADR-19):exact-date 检索结论(hit 正事实 / miss 负事实)追加进
      // bookable-facts 侧车——产物事实闸(gotry_fact_gate)的唯一事实源;落盘失败不阻塞检索
      const avMap = await loadAirlineAirportMap()
      await appendFacts(config.stateRoot ?? '.', factsFromFlyai({ kind, origin: q.from, destination: q.to, date: q.date }, r, new Date().toISOString(), avMap?.city_alias))
      const top = (r.options ?? []).slice(0, 8).map(o => `${o.no} ${o.name} ${o.depDateTime.slice(11, 16)}→${o.arrDateTime.slice(11, 16)} ¥${o.price}`)
      // issue #24:miss(上游正常返回 0 条)与 error(限流/网络)分开陈述,不再混写「无结果或失败」
      // (过去日期已被上方预校验拦下,此处不会出现过期查询)
      const label = kind === 'flight' ? '机票' : '火车票'
      const summary = r.verdict === 'hit'
        ? `${q.from}→${q.to} ${q.date} ${label}(飞猪官方只读)前 ${top.length} 条:\n${top.join('\n')}\n${r.evidence}`
        : r.verdict === 'miss'
          ? `${q.from}→${q.to} ${q.date} ${label}官方通道正常返回 0 条(常见原因:航线未开放/当日售罄)。${r.evidence}`
          : r.verdict === 'needs-setup'
            ? `${q.from}→${q.to} ${q.date} ${label}检索未发起(配置问题,非检索失败):${r.error ?? ''}\n${r.setup ?? ''}\n状态体检可调 gotry_doctor。${r.evidence}`
            : `${q.from}→${q.to} ${q.date} ${label}检索失败(可能限流/网络):${r.error ?? ''} ${r.evidence}`
      return JSON.parse(JSON.stringify({
        ...r, kind, summary,
        ...(r.verdict !== 'hit' ? routingField(kind === 'train' ? 'search-train' : 'search-flight', 'flyai') : {}),
      })) as Record<string, never>
    },
    presentCall: args => ({ card: 'generic', title: `官方检索:${args.kind}`, kind: 'fetch', rawInput: args }),
    presentResult: (args, value) => {
      const isHotel = args.kind === 'hotel'
      const r = value as { ok?: boolean; options?: unknown[]; hotels?: unknown[] }
      const n = Math.max((r.options ?? []).length, (r.hotels ?? []).length)
      return { card: 'generic', title: `${isHotel ? '飞猪酒店' : '飞猪检索'}:${r.ok && n > 0 ? `${n} 条` : '降级'}`, content: [{ type: 'text', text: String((value as { summary?: string }).summary ?? '') }] }
    },
  }))

  registerGuarded(defineTool({
    name: 'gotry_session_login',
    description:
      'Productized login bootstrap for the account session channel (call this when gotry_session_search returns needs-login — the user never needs a terminal). ' + 'AUTO-DETECTION FIRST: it reads ticket-cookie NAMES before anything else — if the user already logged in (on the external site) it confirms instantly WITHOUT opening any page. '
      + 'OPENS the site login entry in the USER\'S OWN Chrome (foreground tab, left open for the user) and waits for the user to finish logging in on the external site. '
      + 'GoTry NEVER collects, stores, or transmits credentials: no passwords, no SMS codes, no cookie values — it only checks the boolean fact "already logged in" (reads cookie NAMES only, zero values). '
      + 'Transport: the GoTry Session Bridge browser extension (one-time install, ZERO Chrome system dialogs). '
      + `verdict logged-in (tickets detected) | pending (login tab opened, user not done yet — offer to re-check later) | needs-extension (one-time extension install: the verdict surfaces the Chrome Web Store installUrl as a clickable link for dsh UI to render — installation is a browser concern, not gotry's). `
      + 'Evidence [会话:<site>-login@ts].',
    // D-30 第三刀(issue #112):query blob → 平铺 typed;全字段可选 → interpretArgs 容忍层
    parameters: {
      waitSeconds: { type: 'integer', description: '等待用户完成登录的上限秒数,默认 90,至多 300;不传用默认' },
    },
    output: { schema: { type: 'json' }, render: (_a, v) => [{ type: 'text', text: String((v as { evidence?: string }).evidence ?? JSON.stringify(v).slice(0, 600)) }] },
    async execute(args, _exec: unknown) {
      const q = unwrapQuery<{ waitSeconds?: number }>(args, 'waitSeconds')
      const r = await sessionLogin({ waitMs: typeof q?.waitSeconds === 'number' ? q.waitSeconds * 1000 : undefined })
      const summary = r.verdict === 'logged-in'
        ? `${r.site} 登录完成确认(票据 cookie 名已检出,只读名字)。说明:登录是在携程官网、用你自己的浏览器完成的——gotry 全程未接触任何密码/验证码/cookie 值。现在可以继续会话检索了。${r.evidence}`
        : r.verdict === 'pending'
          ? `登录入口已在你的 Chrome 打开;请在弹出的标签页里正常登录携程(登录由你在官网完成,不属于 gotry)。完成后说一声"继续",我再确认。gotry 只检查"是否已登录",永不收集你的账号信息。${r.evidence}`
          : r.verdict === 'needs-extension'
            ? `需要一次性安装 GoTry Session Bridge 浏览器扩展:这是浏览器的事,gotry 不弹面板不开剪贴板——请直接在 Chrome 应用商店一键装(add-to-chrome 自动更新)。storeUrl=${EXTENSION_STORE_URL}. 装好即生效,装完后告诉我「重试」即可。${r.evidence}`
            : r.verdict === 'needs-attach'
              ? `cdp 车道需要一次性开启你 Chrome 的远程调试开关:在你的 Chrome 地址栏打开 chrome://inspect/#remote-debugging 并打开开关,然后说一声"重试"(默认走扩展车道,无需此步)。${r.evidence}`
              : `登录引导未完成:${r.error ?? '未知原因'} ${r.evidence}`
      return JSON.parse(JSON.stringify({ ...r, summary })) as Record<string, never>
    },
    presentCall: _args => ({ card: 'generic', title: '登录携程(用你自己的浏览器,不在 gotry 输入)', kind: 'fetch', rawInput: {} }),
    presentResult: (_args, value) => {
      const r = value as { verdict?: string; tickets?: string[]; installUrl?: string }
      const needsExt = r.verdict === 'needs-extension'
      const label = r.verdict === 'logged-in'
        ? `已登录(${(r.tickets ?? []).length} 票据)`
        : r.verdict === 'pending'
          ? '等待你在携程页面完成登录'
          : needsExt
            ? '🧩 需装 GoTry Session Bridge 扩展(浏览器商店一键装,自动更新)'
            : r.verdict ?? '降级'
      const content: Array<{ type: 'text'; text: string }> = [{ type: 'text', text: String((value as { summary?: string }).summary ?? '') }]
      // needs-extension:把商店 URL 渲成可点链接(浏览器自己当安装器,gotry 不插手)
      // dsh presentResult 若支持 actions 字段,URL 可被原生渲染;否则 content 里也保留文本兜底
      if (needsExt && r.installUrl) content.push({ type: 'text', text: `安装链接:${r.installUrl}` })
      return { card: 'generic', title: `账号登录:${label}`, content }
    },
  }))

  registerGuarded(defineTool({
    name: 'gotry_session_search',
    description:
      'Search on the USER\'S OWN browser session (Ctrip kind="flight"(default)/"hotel"; 12306 kind="train" — public query face, no login needed). '
      + 'Consent gate: the FIRST call in a session asks the user via the runtime approval card; once granted it holds for the session, a refusal revokes it for the session (no repeat prompting). '
      + 'Transport: GoTry Session Bridge browser extension (one-time install) — the agent side never talks to Chrome debugging, ZERO system dialogs; read-only by construction (the extension never issues requests; it only passively forwards the site\'s own search responses; agent NEVER touches credentials/captcha; on captcha it stops and returns challenged). '
      + 'kind="flight": from/to 中文城市名 + date YYYY-MM-DD — sniffs the site search API for structured options. Evidence [会话:ctrip-flight@ts]. '
      + 'kind="hotel": to=目的地中文, cityId? = the numeric city= in a hotels.ctrip.com list URL (web-search it when the destination is outside the built-in city table), checkIn?/checkOut? (YYYY-MM-DD), adults?; hotel prices are the user\'s real logged-in prices. Evidence [会话:ctrip-hotel@ts]. '
      + 'kind="train": from/to/date(YYYY-MM-DD) + fromStationTelecode?/toStationTelecode? (three-letter codes in the kyfw query URL, for cities outside the built-in table) — 12306 left-ticket query (public face): train codes, times, durations, seat availability; the list API carries NO prices (prices live on the 12306 page). Evidence [会话:train-12306@ts]. '
      + 'verdict needs-login = call gotry_session_login (opens the Ctrip login entry in the user\'s own foreground tab — no terminal, no credentials through GoTry); '
      + `needs-extension = one-time browser-extension install (Chrome Web Store one-click, installUrl is also surfaced as a clickable link in the verdict field for dsh UI to render) — the DEFAULT transport; cdp (chrome://inspect remote debugging) is a diagnostic fallback only via GOTRY_SESSION_TRANSPORT=cdp. `
      + 'Rate-limited (≥30s between same-site calls; a challenged/timeout verdict means STOP — never retry, fall back to other tools).',
    // D-30 第二刀(issue #112):query blob → 平铺 typed 契约(逐字段 schema 模型可见)。
    // 与 flyai 刀的差异:本工具三意图无公共 required 字段(kind 缺省=flight),根 schema 是
    // 隐式开放对象,宿主权无法用 required 拒 legacy blob——故保留 interpretArgs 容忍层
    // (tool-orchestration-design §4③「interpretArgs 留作旧形态容忍层」),blob 调用在
    // execute 内归一后走原条件闸,结构化报错不崩。flyai 因 kind required 仍在宿主权即拒。
    parameters: {
      kind: { type: 'string', enum: ['flight', 'hotel', 'train'], description: '默认 flight 机票;hotel 携程酒店(用户登录态真实价);train 12306 余票(公开面)' },
      from: { type: 'string', description: '出发城市中文(词表内),如 上海——kind=flight|train 必填' },
      to: { type: 'string', description: '到达城市中文——kind=flight|train 必填;kind=hotel 时为目的地(必填)' },
      date: { type: 'string', description: '出发日期 YYYY-MM-DD——kind=flight|train 必填,须为今天或未来' },
      cityId: { type: 'integer', description: '携程酒店 city= 数字,仅 kind=hotel;目的地码表外时 web 搜 hotels.ctrip.com list URL 取 city=' },
      checkIn: { type: 'string', description: '入住日 YYYY-MM-DD,仅 kind=hotel 可选' },
      checkOut: { type: 'string', description: '退房日 YYYY-MM-DD,仅 kind=hotel 可选' },
      adults: { type: 'integer', description: '成人数,仅 kind=hotel 可选' },
      fromStationTelecode: { type: 'string', description: '出发站三位电报码,仅 kind=train;城市码表外时填(kyfw 查询页 URL 里)' },
      toStationTelecode: { type: 'string', description: '到达站三位电报码,仅 kind=train,同上' },
    },
    output: { schema: { type: 'json' }, render: (_a, v) => [{ type: 'text', text: String((v as { summary?: string }).summary ?? JSON.stringify(v).slice(0, 600)) }] },
    async execute(args, _exec) {
      const q = unwrapQuery<{ kind?: string; from?: string; to?: string; date?: string; cityId?: number | string; checkIn?: string; checkOut?: string; adults?: number; fromStationTelecode?: string; toStationTelecode?: string }>(args)
      // ---- 会话酒店(2026-09-03 实装;2026-09-02 迪拜 session:用户要携程找酒店,会话面却只有机票)----
      // ---- 会话火车(2026-09-03 实装;12306 公开查询面,无登录闸)----
      if (q.kind === 'train') {
        if (!q.from || !q.to || !q.date) {
          return { ok: false, summary: 'kind=train 需要 from/to(中文城市/车站名)与 date(YYYY-MM-DD);城市电报码表外带 fromStationTelecode/toStationTelecode(kyfw 查询页 URL 里的三位码)' } as const
        }
        const nowT = new Date()
        const todayT = `${nowT.getFullYear()}-${String(nowT.getMonth() + 1).padStart(2, '0')}-${String(nowT.getDate()).padStart(2, '0')}`
        if (q.date < todayT) {
          return JSON.parse(JSON.stringify({
            ok: false, verdict: 'error',
            summary: `未发起查询:日期 ${q.date} 已是过去(今天 ${todayT}),过去不存在在售火车票。向用户确认日期后再查。`,
          })) as Record<string, never>
        }
        const itpT = await interpretEffect({
          effect: 'SESSION_TRAIN_SEARCH',
          params: {
            from: q.from, to: q.to, date: q.date,
            fromStationTelecode: q.fromStationTelecode, toStationTelecode: q.toStationTelecode,
            auditPath: join(config.stateRoot ?? '.', 'gotry-state', 'session-incidents.jsonl'),
          },
        })
        if (!itpT.result) return declinedObservation('SESSION_TRAIN_SEARCH', itpT.trace)
        const rT = itpT.result
        await noteChannel('session:12306-train', rT.verdict)
        const topT = (rT.trains ?? []).slice(0, 10).map(t => `${t.trainCode} ${t.depTime}→${t.arrTime} 历时${Math.round(t.durationMin / 60 * 10) / 10}h ${t.canWebBuy === 'Y' ? '可订' : t.canWebBuy}${Object.entries(t.seats).filter(([, v]) => v && v !== '--' && v !== '无').slice(0, 3).map(([k, v]) => `${k}:${v}`).join(' ')}`)
        const summaryT = rT.verdict === 'hit'
          ? `${q.from}→${q.to} ${q.date} 余票(12306 公开查询面,${(rT.trains ?? []).length} 趟)前 ${topT.length} 条(列表接口不含票价,票价以 12306 落地页为准):\n${topT.join('\n')}\n${rT.evidence}`
          : rT.verdict === 'cooldown'
            ? `会话火车检索节律闸冷却中(两次会话检索需 ≥30s 间隔)——稍候重试或先用其他工具推进。${rT.evidence}`
            : `会话火车检索未取回(${rT.verdict}):${rT.error ?? ''} ${rT.evidence}`
        return JSON.parse(JSON.stringify({
          ...rT, summary: summaryT,
          ...(rT.verdict !== 'hit' ? routingField('search-train', 'session:12306-train') : {}),
        })) as Record<string, never>
      }
      if (q.kind === 'hotel') {
        if (!q.to) {
          return { ok: false, summary: 'kind=hotel 需要 to(目的地中文;城市码表外带 cityId=携程酒店 list 页 URL 里的 city= 数字)' } as const
        }
        const itp = await interpretEffect({
          effect: 'SESSION_HOTEL_SEARCH',
          params: {
            to: q.to, cityId: q.cityId, checkIn: q.checkIn, checkOut: q.checkOut, adults: q.adults,
            auditPath: join(config.stateRoot ?? '.', 'gotry-state', 'session-incidents.jsonl'),
          },
        })
        if (!itp.result) return declinedObservation('SESSION_HOTEL_SEARCH', itp.trace)
        const r = itp.result
        await noteChannel('session:ctrip-hotel', r.verdict)
        const top = (r.hotels ?? []).slice(0, 8).map(h => `${h.name}${h.star ? `(${h.star}星)` : ''} ${h.priceRaw ?? (h.price > 0 ? `¥${h.price}` : '价待询')}${h.score ? ` 评分${h.score}` : ''}`)
        const summary = r.verdict === 'hit'
          ? `${q.to} 酒店(携程,用户本人登录态,真实价)前 ${top.length} 家(预订以 jumpUrl 落地页为准):\n${top.join('\n')}\n${r.evidence}`
          : r.verdict === 'cooldown'
            ? `会话酒店检索节律闸冷却中(两次会话检索需 ≥30s 间隔)——稍候重试或先用其他工具推进。${r.evidence}`
            : `会话酒店检索未取回(${r.verdict}):${r.error ?? ''} ${r.evidence}`
        return JSON.parse(JSON.stringify({
          ...r, summary,
          ...(r.verdict !== 'hit' ? routingField('search-hotel', 'session:ctrip-hotel') : {}),
        })) as Record<string, never>
      }
      if (!q.from || !q.to || !q.date) {
        return { ok: false, summary: '需要 from/to(中文城市名,词表内)与 date(YYYY-MM-DD);酒店/火车检索分别用 kind=hotel / kind=train' } as const
      }
      // 效应解译层(ADR-18):SESSION 通道策略=永不重试/不熔断,节律闸在渠道内;
      // 解译器只做分发与证据拼装,verdict 语义(risk 型 needs-login/challenged)原样透传
      const itp = await interpretEffect({
        effect: 'SESSION_FLIGHT_SEARCH',
        params: {
          from: q.from, to: q.to, date: q.date,
          // ADR-15 收尾:ReadGuard 审计在生产工具路径同样落盘(此前仅测试传隔离 stateRoot 才有 JSONL)
          auditPath: join(config.stateRoot ?? '.', 'gotry-state', 'session-incidents.jsonl'),
        },
      })
      if (!itp.result) return declinedObservation('SESSION_FLIGHT_SEARCH', itp.trace)
      const r = itp.result
      await noteChannel('session:ctrip-flight', r.verdict)
      // issue #46 事实落账(ADR-19):会话面 exact-date 结论同样进事实注册表(独立 source 并列标注)
      const avMapS = await loadAirlineAirportMap()
      await appendFacts(config.stateRoot ?? '.', factsFromSession({ origin: q.from, destination: q.to, date: q.date }, r, new Date().toISOString(), avMapS?.city_alias))
      const top = (r.options ?? []).slice(0, 8).map(o => `${o.flightNo} ${o.airline} ${o.depDateTime.slice(11, 16)}→${o.arrDateTime.slice(11, 16)} ¥${o.price}`)
      const summary = r.verdict === 'hit'
        ? `${q.from}→${q.to} ${q.date} 会话检索(携程,用户本人登录态)前 ${top.length} 条:\n${top.join('\n')}\n${r.evidence}`
        : `会话检索未取回(${r.verdict}):${r.error ?? ''} ${r.evidence}`
      return JSON.parse(JSON.stringify({
        ...r, summary,
        ...(r.verdict !== 'hit' ? routingField('search-flight', 'session:ctrip-flight') : {}),
      })) as Record<string, never>
    },
    presentCall: args => {
      const callTitle = args.kind === 'hotel' ? `会话酒店:${args.to ?? ''}` : args.kind === 'train' ? `会话火车:${args.from ?? ''}` : `会话检索:${args.from ?? ''}`
      return { card: 'generic', title: callTitle, kind: 'fetch', rawInput: args }
    },
    presentResult: (args, value) => {
      const r = value as { verdict?: string; options?: unknown[]; hotels?: unknown[]; installUrl?: string }
      const isHotel = args.kind === 'hotel'
      const n = Math.max((r.options ?? []).length, (r.hotels ?? []).length)
      const needsExt = r.verdict === 'needs-extension'
      const label = r.verdict === 'hit'
        ? `会话 ${n} 条`
        : r.verdict === 'needs-login'
          ? '需登录'
          : needsExt
            ? '🧩 需装 GoTry Session Bridge 扩展(浏览器商店一键装,自动更新)'
            : r.verdict ?? '降级'
      const content: Array<{ type: 'text'; text: string }> = [{ type: 'text', text: String((value as { summary?: string }).summary ?? '') }]
      if (needsExt && r.installUrl) content.push({ type: 'text', text: `安装链接:${r.installUrl}` })
      const face = args.kind === 'hotel' ? '会话酒店' : args.kind === 'train' ? '会话火车' : '会话检索'
      return { card: 'generic', title: `${face}:${label}`, content }
    },
  }))

  registerGuarded(defineTool({
    name: 'gotry_anything_search',
    description:
      'Travel-domain search via hotel-byte CLI → hotel-be Anything (cities/hotels/destinations) — NOT general web search; for general internet facts use gotry_agent_reach. ' +
      'Mixed destinations (cities / metropolitan areas / high-level regions) + hotels in one call. ' +
      'Returns candidates with type, name, optional coordinates and hotel-id. ' +
      'Three-valued semantics: hit = ≥1 candidate; miss = 0 candidates (try synonyms or contentType=city/hotel); ' +
      'unavailable = hbcli failed (degraded, never blocks). ' +
      'Use as the first stop when the user mentions a place/city/hotel name and you need to ground it in real catalog data ' +
      '(OpenFlights skeleton tells you connectivity; Anything tells you what EXISTS at a city/region).',
    parameters: {
      query: {
        type: 'json',
        required: true,
        description: '{ keyword: "<搜索关键词>", contentType?: "city"|"hotel", parentDestinationId?: "?", timeoutMs?: 12000 }',
      },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: String((value as { summary?: string }).summary ?? JSON.stringify(value).slice(0, 800)) }],
    },
    async execute(args: { query: unknown }, _exec: unknown) {
      const q = unwrapQuery<{ keyword: string; contentType?: 'city' | 'hotel'; parentDestinationId?: string | number; timeoutMs?: number }>(args, 'keyword')
      const started = Date.now()
      if (!q.keyword) {
        return JSON.parse(JSON.stringify({ ok: false, verdict: 'error', summary: 'keyword 必填', evidence: '[hbcli-anything@error] empty' })) as Record<string, never>
      }
      const r = await anythingSearch(q)
      const dir = await ensureStateDir(config.stateRoot)
      await recordLatency(join(dir, 'bridge-latency.jsonl'), Date.now() - started, `anything:${r.via}`).catch(() => {})
      const top5 = (r.hits ?? []).slice(0, 5)
      const summary = r.verdict === 'hit'
        ? `${q.keyword} → hit (${r.hits?.length ?? 0} 候选项)\n${top5.map((h, i) => `  ${i + 1}. [${h.type}] ${h.name}${h.latitude !== undefined && h.longitude !== undefined ? ` @ (${h.latitude.toFixed(3)},${h.longitude.toFixed(3)})` : ''}`).join('\n')}\n${r.evidence}`
        : r.verdict === 'miss'
          ? `${q.keyword} → miss (酒店-be 一切正常但无候选)\n${r.evidence}`
          : `${q.keyword} → unavailable (${r.error})\n${r.evidence}`
      return JSON.parse(JSON.stringify({
        ok: r.ok, verdict: r.verdict, keyword: q.keyword,
        content_type: q.contentType ?? null,
        total_candidates: r.totalCandidates, hits: r.hits, evidence: r.evidence, summary,
        latency_ms: Date.now() - started,
      })) as Record<string, never>
    },
    presentCall: args => ({ card: 'generic', title: `Anything search:${String((args.query as { keyword?: string })?.keyword ?? '')}`, kind: 'search', rawInput: args.query }),
    presentResult: (_args, value) => {
      const r = value as { hits?: unknown[]; total_candidates?: number; verdict?: string; keyword?: string; summary?: string }
      const n = Array.isArray(r.hits) ? r.hits.length : (r.total_candidates ?? 0)
      return {
        card: 'generic',
        title: `Anything:${r.keyword ?? ''} ${r.verdict === 'hit' ? `${n} hits` : (r.verdict ?? 'no-result')}`,
        content: [{ type: 'text', text: String(r.summary ?? '') }],
      }
    },
  }))

  registerGuarded(defineTool({
    name: 'gotry_web_search',
    description:
      'Read any public URL as markdown (Jina Reader, free, no key). ' +
      'Use as the "last mile" web reader when hotel-be Anything or gotry tools lack the answer. ' +
      'NOT a general-purpose search engine — only fetches a URL you already know. ' +
      'Three-valued: ok / error(非法 URL/超时)/not-reachable(r.jina.ai 不可用).' +
      'Contract with gotry capabilities/anything.ts: 同构(L4 证据链 + 降级不阻塞 + 三值)。',
    parameters: {
      query: {
        type: 'json',
        required: true,
        description: '{ url: "https://example.com", timeoutMs?: 20000 }',
      },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: String((value as { content?: string }).content?.slice(0, 800) ?? JSON.stringify(value).slice(0, 800)) }],
    },
    async execute(args: { query: unknown }, _exec: unknown) {
      const q = unwrapQuery<{ url?: string; timeoutMs?: number }>(args, 'url')
      const started = Date.now()
      if (!q.url) {
        return JSON.parse(JSON.stringify({ ok: false, summary: 'url 必填', evidence: '[agent-reach:error] empty url' })) as Record<string, never>
      }
      const r = await readUrl({ url: q.url, timeoutMs: q.timeoutMs })
      const dir = await ensureStateDir(config.stateRoot)
      await recordLatency(join(dir, 'bridge-latency.jsonl'), Date.now() - started, `agent-reach:${r.via}`).catch(() => {})
      const summary = r.ok
        ? `${q.url} → ${r.title ?? '(no title)'} (${r.latencyMs}ms)\n${r.evidence}\n---\n${r.content?.slice(0, 600) ?? ''}`
        : `${q.url} → unavailable (${r.error})\n${r.evidence}`
      return JSON.parse(JSON.stringify({
        ok: r.ok, url: q.url, via: r.via, title: r.title,
        content: r.content, evidence: r.evidence, summary,
        latency_ms: Date.now() - started,
      })) as Record<string, never>
    },
    presentCall: args => ({ card: 'generic', title: `读网页:${String((args.query as { url?: string })?.url ?? '')}`, kind: 'fetch', rawInput: args.query }),
  }))

  registerGuarded(defineTool({
    name: 'gotry_video_subtitle',
    description:
      'Extract subtitles from a YouTube/Bilibili video (yt-dlp, optional tool). ' +
      'If yt-dlp is installed on this machine, returns the subtitle text (vtt, zh-Hans/zh/en preference). ' +
      'If NOT installed, degrades gracefully with install instructions — never blocks. ' +
      'Evidence chain: [agent-reach:yt-dlp@ts] / [@not-installed@ts].',
    parameters: {
      query: {
        type: 'json',
        required: true,
        description: '{ url: "https://www.youtube.com/watch?v=...", lang?: "zh-Hans,zh,en" }',
      },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: String((value as { summary?: string }).summary ?? JSON.stringify(value).slice(0, 600)) }],
    },
    async execute(args: { query: unknown }, _exec: unknown) {
      const q = unwrapQuery<{ url?: string; lang?: string }>(args, 'url')
      if (!q.url) {
        return JSON.parse(JSON.stringify({ ok: false, summary: 'url 必填' })) as Record<string, never>
      }
      const r = await videoSubtitle({ url: q.url, lang: q.lang })
      const summary = r.verdict === 'found'
        ? `${q.url} 字幕提取成功 (${r.latencyMs}ms)\n${r.evidence}\n---\n${(r.subtitles ?? '').slice(0, 800)}`
        : r.verdict === 'not-installed'
          ? `yt-dlp 未安装。${r.stderr}\n${r.evidence}`
          : `${q.url} 字幕提取失败(${r.verdict})\n${r.evidence}`
      return JSON.parse(JSON.stringify({
        ok: r.ok, verdict: r.verdict, url: q.url,
        subtitles: r.subtitles?.slice(0, 4000), evidence: r.evidence, summary,
        latency_ms: r.latencyMs,
      })) as Record<string, never>
    },
    presentCall: args => ({ card: 'generic', title: `视频字幕:${String((args.query as { url?: string })?.url ?? '')}`, kind: 'fetch', rawInput: args.query }),
  }))

  registerGuarded(defineTool({
    name: 'gotry_github_search',
    description:
      'Search GitHub repositories (gh CLI, optional tool). ' +
      'If gh is installed and authenticated, returns repos with name/description/stars/url. ' +
      'If NOT installed, degrades with install instructions — never blocks. ' +
      'Evidence chain: [agent-reach:gh@ts] / [@not-installed@ts].',
    parameters: {
      query: {
        type: 'json',
        required: true,
        description: '{ query: "agent-reach", limit?: 5 }',
      },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: String((value as { summary?: string }).summary ?? JSON.stringify(value).slice(0, 600)) }],
    },
    async execute(args: { query: unknown }, _exec: unknown) {
      const q = unwrapQuery<{ query?: string; limit?: number }>(args, 'query')
      if (!q.query) {
        return JSON.parse(JSON.stringify({ ok: false, summary: 'query 必填' })) as Record<string, never>
      }
      const r = await githubSearch({ query: q.query, limit: q.limit })
      const summary = r.verdict === 'found'
        ? `${q.query} → ${r.repos?.length ?? 0} repos\n${(r.repos ?? []).map((x, i) => `  ${i + 1}. ${x.name} ★${x.stars ?? '?'} — ${(x.description ?? '').slice(0, 60)}`).join('\n')}\n${r.evidence}`
        : r.verdict === 'not-installed'
          ? `gh 未安装。${r.stderr}\n${r.evidence}`
          : `${q.query} 搜索失败(${r.verdict})\n${r.evidence}`
      return JSON.parse(JSON.stringify({
        ok: r.ok, verdict: r.verdict, query: q.query,
        repos: r.repos, evidence: r.evidence, summary,
        latency_ms: r.latencyMs,
      })) as Record<string, never>
    },
    presentCall: args => ({ card: 'generic', title: `GitHub 搜索:${String((args.query as { query?: string })?.query ?? '')}`, kind: 'search', rawInput: args.query }),
  }))

  registerGuarded(defineTool({
    name: 'gotry_agent_reach',
    description:
      'Agent Reach — the PRIMARY external-data gateway (thin wrapper over Panniantong/Agent-Reach upstream registry, zero channel knowledge here). ' +
      'Prefer this for ANY external/internet fact beyond weather/flights/hotels. ' +
      'Call ANY upstream channel method by reflection: web.read(url) / v2ex.get_hot_topics() / v2ex.search(query) / ' +
      'xueqiu.get_stock_quote(symbol) / xueqiu.search_stock(query) / youtube.transcribe(url) / <channel>.check() ... ' +
      'Unknown channel or method? Just call it — the error returns the upstream inventory (channel list or method signatures) so you can self-correct. ' +
      'Action "status" runs the real `agent-reach doctor` (.venv/bin/agent-reach). ' +
      'Channels needing cookies/setup return the upstream check() guidance verbatim — do NOT give up there: hand the user the exact configure command, then offer to re-check. ' +
      'Evidence chain: [agent-reach:<channel>.<method>@ts].',
    // D-30 第三刀(issue #112):query blob → 平铺 typed;全字段可选 → interpretArgs 容忍层。
    // action 不设 enum:反射桥按 D-4a' 透传上游新增渠道/方法,gotry 零改动(生态开放面)
    parameters: {
      action: { type: 'string', description: 'status(默认,无 channel 时)或 reach' },
      channel: { type: 'string', description: '上游渠道名,如 web/v2ex/xueqiu(action=reach 时)' },
      method: { type: 'string', description: '上游方法名,如 read/get_hot_topics/get_stock_quote' },
      args: { type: 'string', description: '空格分隔参数' },
      timeoutMs: { type: 'integer', description: '超时毫秒' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: String((value as { summary?: string }).summary ?? JSON.stringify(value).slice(0, 800)) }],
    },
    async execute(args, _exec: unknown) {
      const q = unwrapQuery<{ action?: string; channel?: string; method?: string; args?: string; timeoutMs?: number }>(args, 'channel')
      const started = Date.now()
      const dir = await ensureStateDir(config.stateRoot)

      if (q.action === 'status' || (!q.action && !q.channel)) {
        const st = await reachStatus(q.timeoutMs)
        await recordLatency(join(dir, 'bridge-latency.jsonl'), Date.now() - started, 'agent-reach:doctor').catch(() => {})
        const summary = st.via === 'agent-reach-cli'
          ? `Agent Reach doctor(上游 CLI,原样透传):\n${st.output}\n${st.evidence}`
          : `Agent Reach 未装配(.venv 缺失)——可选依赖,机/酒/网页社媒读取之外的工具不受影响。\n补装:终端跑 npx gotry doctor --fix;整体依赖状态可调 gotry_doctor 工具查看。\n${st.evidence}`
        return JSON.parse(JSON.stringify({
          ok: st.ok, via: st.via, output: st.output, evidence: st.evidence, summary,
          latency_ms: Date.now() - started,
        })) as Record<string, never>
      }

      if (!q.channel || !q.method) {
        return JSON.parse(JSON.stringify({ ok: false, summary: 'channel 与 method 必填(或 action=status);清单可先随便调一次,inventory 会带回上游渠道/方法表' })) as Record<string, never>
      }
      const r = await reach({ channel: q.channel, method: q.method, args: q.args, timeoutMs: q.timeoutMs })
      // 长结果干净截断:数组按条目边界保留(dsh 工具上限会拦腰断 JSON,模型只能看到半条)
      const dataStr = (v: unknown): unknown => {
        if (Array.isArray(v)) {
          const kept: unknown[] = []
          let budget = 3500
          for (const item of v) {
            const s = JSON.stringify(item)
            if (budget - s.length < 0) break
            budget -= s.length + 1
            kept.push(item)
          }
          if (kept.length < v.length) kept.push(`…(截断:保留 ${kept.length}/${v.length} 条;可用上游方法带 limit 参数取更少)`)
          return kept
        }
        if (typeof v === 'string') return v.length > 4000 ? v.slice(0, 4000) + '…(截断)' : v
        return v
      }
      if (r.ok) r.data = dataStr(r.data)
      await recordLatency(join(dir, 'bridge-latency.jsonl'), Date.now() - started, `agent-reach:${q.channel}.${q.method}:${r.verdict}`).catch(() => {})
      const summary = r.verdict === 'found'
        ? `${q.channel}.${q.method} → found (${r.latencyMs}ms)\n${r.evidence}\n${typeof r.data === 'string' ? r.data.slice(0, 600) : JSON.stringify(r.data ?? null).slice(0, 600)}`
        : r.verdict === 'needs-setup'
          ? `${q.channel}.${q.method} → 需配置(上游 check() 原话): ${r.setup ?? ''}\n${r.evidence}`
          : r.verdict === 'not-installed'
            ? `${q.channel}.${q.method} → 上游未装配(可选依赖): ${r.setup ?? ''}\n整体依赖状态可调 gotry_doctor 查看;补装: npx gotry doctor --fix\n${r.evidence}`
            : `${q.channel}.${q.method} → ${r.error ?? 'error'}${r.inventory ? `\n上游清单: ${JSON.stringify(r.inventory).slice(0, 1200)}` : ''}\n${r.evidence}`
      return JSON.parse(JSON.stringify({
        ok: r.ok, channel: r.channel, method: q.method, verdict: r.verdict,
        data: typeof r.data === 'string' ? r.data.slice(0, 4000) : r.data,
        inventory: r.inventory, setup: r.setup, evidence: r.evidence, summary,
        latency_ms: Date.now() - started,
      })) as Record<string, never>
    },
    presentCall: args => ({ card: 'generic', title: `Agent Reach:${String(args.channel ?? '')}.${String(args.method ?? 'status')}`, kind: 'fetch', rawInput: args }),
    presentResult: (args, value) => {
      const r = value as { verdict?: string; summary?: string }
      const q = (args as { channel?: string; method?: string }) ?? {}
      const icon = r.verdict === 'found' ? '✅' : r.verdict === 'needs-setup' ? '🔧' : r.verdict === 'not-installed' ? '📦' : '❌'
      return {
        card: 'generic',
        title: `AgentReach ${icon} ${q.channel ?? ''}.${q.method ?? 'status'} ${r.verdict ?? ''}`,
        content: [{ type: 'text', text: String(r.summary ?? '') }],
      }
    },
  }))

  // ---- 依赖体检面(2026-09-02 迪拜 session 复盘:可选依赖未装配时,LLM 需要一个
  // 统一的状态入口来「显示状态 + 引导补装」,而不是在 not-installed 里各自摸索)----

  registerGuarded(defineTool({
    name: 'gotry_doctor',
    description:
      'Check optional-dependency health for ALL gotry tools (read-only, never installs): GoTry Session Bridge extension / Agent Reach (.venv) / hbcli (hotel realtime) / FlyAI key + recent trial-quota exhaustion time / dsh-calendar mount state / dsh-better-sidebar. '
      + 'Call this when ANY gotry tool returns not-installed / needs-setup, when the user asks 「体检/依赖状态/工具为什么不可用」, or BEFORE leaning on a channel for a plan. '
      + 'Returns per-item status (ok/degraded/missing) with exact fix commands. '
      + 'Repair = `npx gotry doctor --fix` run BY THE USER in a terminal (this tool never installs anything); LLM keys are the dsh host\'s business and are deliberately out of scope. '
      + 'A markdown report is rendered for the workspace (gotry-state/doctor-report.md) so the sidebar workbench can preview it.',
    // D-30 第三刀(issue #112):query blob → 平铺 typed;全字段可选 → interpretArgs 容忍层
    parameters: {
      writeReport: { type: 'boolean', description: '默认 true,把 markdown 报告写进 gotry-state/doctor-report.md(侧栏工作台可预览)' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: String((value as { summary?: string }).summary ?? JSON.stringify(value).slice(0, 900)) }],
    },
    async execute(args, _exec: unknown) {
      const q = unwrapQuery<{ writeReport?: boolean }>(args, 'writeReport')
      const report = await runDoctorChecks({ stateRoot: config.stateRoot ?? '.' })
      // 报告落 gotry-state(侧栏工作台预览面);写失败不阻塞体检结论本身
      let reportPath: string | undefined
      if (q?.writeReport !== false) {
        try {
          const { writeFile } = await import('node:fs/promises')
          const dir = await ensureStateDir(config.stateRoot)
          reportPath = join(dir, 'doctor-report.md')
          await writeFile(reportPath, renderDoctorReportMd(report), 'utf-8')
        } catch { reportPath = undefined }
      }
      const icon = (s: string) => (s === 'ok' ? '✅' : s === 'degraded' ? '⚠️' : '❌')
      const lines = report.items.map(i => `${icon(i.status)} ${i.label}:${i.detail}${i.fix ? `\n   ↳ 修复: ${i.fix}` : ''}`)
      const summary = `${report.summary}\n${lines.join('\n')}${reportPath ? `\n报告已写: ${reportPath}(侧栏工作台可直接预览)` : '\n(报告写盘失败,仅本对话展示)'}`
      return JSON.parse(JSON.stringify({ ok: true, verdict: report.ok ? 'all-clear' : 'needs-attention', items: report.items, report_path: reportPath, evidence: `[doctor@${new Date().toISOString()}]`, summary })) as Record<string, never>
    },
    presentCall: _args => ({ card: 'generic', title: '🩺 依赖体检', kind: 'execute', rawInput: {} }),
    presentResult: (_args, value) => {
      const r = value as { verdict?: string; summary?: string }
      return {
        card: 'generic',
        title: `🩺 依赖体检:${r.verdict === 'all-clear' ? '✅ 全部就绪' : '🔧 有项待处理'}`,
        content: [{ type: 'text', text: String(r.summary ?? '') }],
      }
    },
  }))

  // ---- 产物面(issue #25):agent 生成的文件可在 dsh 内发现与阅读,不再只是本地文件名 ----

  registerGuarded(defineTool({
    name: 'gotry_artifacts_list',
    description:
      'List GoTry artifacts — deep-planning deliverables (async runs from the state ledger) plus agent-written markdown files ' +
      'in the working directory (trip plans etc.). READ-ONLY discovery. ' +
      'Use when the user asks to see/open/revisit a previously generated artifact ' +
      '(「看看刚才生成的行程」「上次的规划在哪」「打开那个 md」) — list first, then read with gotry_artifacts_read.',
    // D-30 第三刀(issue #112):query blob → 平铺 typed;全字段可选 → interpretArgs 容忍层
    parameters: {
      limit: { type: 'integer', description: '最多返回条数,默认 20' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: String((value as { summary?: string }).summary ?? JSON.stringify(value).slice(0, 600)) }],
    },
    async execute(args, _exec: unknown) {
      const q = unwrapQuery<{ limit?: number }>(args, 'limit')
      const r = await listArtifacts({ stateRoot: config.stateRoot ?? '.', limit: q.limit })
      const lines = r.artifacts.map(a =>
        `- [${a.source}] ${a.title}${a.status ? `(${a.status})` : ''} — ${a.path}${a.updated ? ` @ ${a.updated.slice(0, 16).replace('T', ' ')}` : ''}`)
      const summary = r.artifacts.length
        ? `在册产物 ${r.artifacts.length}/${r.total} 项${r.truncated ? '(截断,可加 limit)' : ''}:\n${lines.join('\n')}`
        : '无在册产物(异步深度规划交付与工作目录 md 文件都会出现在这里)'
      return JSON.parse(JSON.stringify({ ok: true, artifacts: r.artifacts, total: r.total, truncated: r.truncated, summary })) as Record<string, never>
    },
    presentCall: () => ({ card: 'generic', title: '列出产物', kind: 'search' }),
    presentResult: (_args, value) => {
      const r = value as { summary?: string; total?: number }
      return {
        card: 'generic',
        title: `产物:${r.total ?? 0} 项在册`,
        content: [{ type: 'text', text: String(r.summary ?? '') }],
      }
    },
  }))

  registerGuarded(defineTool({
    name: 'gotry_artifacts_read',
    description:
      'Read one GoTry artifact as a line-numbered file view rendered directly in the chat UI. ' +
      'Input: the path from gotry_artifacts_list, or a bare async ticket id (e.g. dp-xxxx). ' +
      'Optional offset (1-based) / limit window for paging large files. ' +
      'READ-ONLY; text artifacts only (md/txt/json/jsonl/csv/log/yaml).',
    // D-30 第三刀(issue #112):query blob → 平铺 typed;path required → 宿主权入口拒畸形参数(同 flyai/hotel 刀法)
    parameters: {
      path: { type: 'string', required: true, description: 'list 返回的路径或工单 id' },
      offset: { type: 'integer', description: '起始行号(1 起)' },
      limit: { type: 'integer', description: '窗口行数,默认 400' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: String((value as { content?: string }).content ?? JSON.stringify(value).slice(0, 600)) }],
    },
    async execute(args, _exec) {
      const q = args
      if (!q.path) throw new Error('gotry_artifacts_read requires path')
      if (!q.path) return JSON.parse(JSON.stringify({ ok: false, error: 'path 必填(来自 gotry_artifacts_list)' })) as Record<string, never>
      const r = await readArtifact({ stateRoot: config.stateRoot ?? '.', path: q.path, offset: q.offset, limit: q.limit })
      if (!r.ok) return JSON.parse(JSON.stringify(r)) as Record<string, never>
      return JSON.parse(JSON.stringify({
        ...r,
        summary: `${r.path}(${r.totalLines} 行)第 ${r.offset}-${r.offset + r.lines.length - 1} 行${r.windowed ? `(共 ${r.totalLines} 行,可翻页)` : ''}`,
      })) as Record<string, never>
    },
    presentCall: args => ({ card: 'generic', title: `读产物:${args.path ?? ''}`, kind: 'read', rawInput: args }),
    presentResult: (_args, value) => {
      const r = value as unknown as { ok?: boolean; path?: string; offset?: number; lines?: Array<{ number: number; text: string }>; totalLines?: number; lang?: string; content?: string; error?: string }
      if (!r.ok) {
        return { card: 'generic', title: '读产物失败', content: [{ type: 'text', text: String(r.error ?? '') }] }
      }
      // dsh read 卡:UI 渲染为行号文件视图(issue #25 的「插件能力查看 artifacts」落点)
      return {
        card: 'read' as const,
        title: r.path?.split('/').pop() ?? r.path ?? '',
        path: r.path ?? '',
        offset: r.offset ?? 1,
        lines: r.lines ?? [],
        totalLines: r.totalLines ?? 0,
        lang: r.lang,
        content: [{ type: 'text', text: r.content ?? '' }],
      }
    },
  }))

  // ---- 产物事实闸(issue #46,ADR-19):含可下单事实的产物交付前必过 ----
  // 每个航班号/时刻/机场/价格/政策断言必须回溯到本会话 exact-date 工具结果
  // (bookable-facts 侧车,query_id 可重放);无法回溯即 blocked——不得宣称「已验证方案」。

  registerGuarded(defineTool({
    name: 'gotry_fact_gate',
    description:
      'Factuality gate for itinerary artifacts (issue #46): call BEFORE delivering any artifact that contains bookable facts '
      + '(flight numbers, times, airports, prices, visa/entry policies). Every bookable claim in the markdown is checked against '
      + 'the session fact registry (exact-date tool results recorded by gotry_flyai_search / gotry_session_search — hit AND miss). '
      + 'Blocked when: a claimed flight is absent from the exact-date source (never backfill from route pages/history/adjacent dates); '
      + 'route+date never queried; times contradict the snapshot; carrier→airport mapping conflicts (FD=DMK vs VZ=BKK are NOT interchangeable); '
      + '「联程」without protected_connection=true; policy claims without 「截至 YYYY-MM-DD」; unconditional ✓ on unverified claims. '
      + 'Optional itinerary object enables machine invariants (hotel_nights + onboard_nights = total nights, O&D segments vs flight legs, '
      + 'budget floor ≥ sum of item minimums). verdict=blocked ⇒ fix or downgrade wording — never present as a verified plan.',
    // D-30 第三刀(issue #112):query blob → 平铺 typed;markdown/path 二选一无公共 required
    // → interpretArgs 容忍层;itinerary 保 object+additionalProperties:true(嵌套形状归一在闸内,
    // #118 D-26 渲染原语切片再收紧),给模型「这是对象」的可见信号
    parameters: {
      markdown: { type: 'string', description: '产物全文;与 path 二选一' },
      path: { type: 'string', description: '产物路径(artifacts_list 返回的);与 markdown 二选一' },
      tripYear: { type: 'integer', description: '行程年份,如 2027(日期归一用)' },
      itinerary: { type: 'object', additionalProperties: true, description: '结构化行程 { trip_start, trip_end, stays:[{place,check_in,check_out}], onboard_nights, od_segments:[{from,to,date,mode,legs}], budget_items:[{label,min_cny,max_cny}], claimed_floor_cny? }' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: String((value as { summary?: string }).summary ?? JSON.stringify(value).slice(0, 800)) }],
    },
    async execute(args, _exec: unknown) {
      const q = unwrapQuery<{ markdown?: string; path?: string; tripYear?: number; itinerary?: Record<string, unknown> }>(args, 'markdown')
      const avMap = await loadAirlineAirportMap()
      if (!avMap) {
        return JSON.parse(JSON.stringify({ ok: false, summary: '航司机场映射缺失(data/airline-airports.json)——事实闸不可用,fail closed:产物不得宣称已验证' })) as Record<string, never>
      }
      let markdown = q.markdown
      if (!markdown && q.path) {
        const r = await readArtifact({ stateRoot: config.stateRoot ?? '.', path: q.path })
        if (!r.ok) return JSON.parse(JSON.stringify({ ok: false, summary: `产物读取失败:${String((r as { error?: string }).error ?? '')}` })) as Record<string, never>
        markdown = r.content
      }
      if (!markdown) return JSON.parse(JSON.stringify({ ok: false, summary: '需要 markdown(产物全文)或 path(产物路径)' })) as Record<string, never>
      const itinerary = q.itinerary as import('./bookable-facts.ts').ItineraryFacts | undefined
      const registry = await loadFactRegistry(config.stateRoot ?? '.')
      const report = gateArtifact(markdown, registry, avMap, { trip_year: q.tripYear, itinerary })
      const lines = report.violations.slice(0, 20).map(v => `  L${v.line} [${v.kind}] ${v.detail}`)
      const summary = report.verdict === 'pass'
        ? `事实闸 PASS:${report.traceable}/${report.claims_checked} 可下单 claim 全部回溯到 exact-date 工具结果(query_id 可重放)——可宣称「已验证方案」。`
        : `事实闸 BLOCKED(${report.violations.length} 违例,${report.traceable}/${report.claims_checked} claim 可回溯)——不得宣称「已验证方案」:\n${lines.join('\n')}\n修正路径:逐条改成 exact-date 源返回的事实,或降级为「未确认/当前不可售,到 D-xx 复核」;exact-date miss 的 route+date 不得用历史班期/相邻日期/航线页填充。`
      return JSON.parse(JSON.stringify({ ok: true, ...report, summary })) as Record<string, never>
    },
    presentCall: args => ({ card: 'generic', title: '产物事实闸', kind: 'execute', rawInput: args }),
    presentResult: (_args, value) => {
      const r = value as { verdict?: string; violations?: unknown[]; summary?: string }
      return {
        card: 'generic',
        title: `事实闸:${r.verdict === 'pass' ? '✅ pass' : `⛔ blocked(${r.violations?.length ?? '?'})`}`,
        content: [{ type: 'text', text: String(r.summary ?? '') }],
      }
    },
  }))
}
