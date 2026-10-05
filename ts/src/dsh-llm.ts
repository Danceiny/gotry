/**
 * 真 LlmPort:OpenAI 兼容接口的 provider 中立适配器(DeepSeek/MiniMax-M2 实测)。
 * 零新依赖(node 内建 fetch)。环境变量:LLM_API_KEY/LLM_BASE_URL/LLM_MODEL
 * (兼容旧 DEEPSEEK_* 别名);GOTRY_LLM_TIMEOUT_MS = 单次请求总预算(默认 300000ms,
 * 非正整数忽略)。MiniMax-M2 是推理模型:输出带 <think> 块,
 * 必须先剥离再解析——JSON 藏在 think 里是常见失败模式。
 * 无 key 时抛出明确错误,replay-real 自动回退 mock(ADR-8)。
 * 责任铁律不变:本适配器只做翻译/润色/解释,判定与算术在确定性组件。
 */

import type { LlmPort } from './loop.ts'
import type { InterviewQuestion, TravelerProfile, TripState, Turn, CalendarState } from './contracts.ts'
import { parseFlightPackToSpec, type JourneySpecTS } from './unified.ts'
import { buildTimeAnchor } from './time-anchor.ts'
import { buildSlotSystem, flagExpiredSlots, normalizeExtraction, type TravelSlotExtraction } from './travel-slots.ts'
import { mergeProfileWorkWindow } from './flight-pack-adapter.ts'

// 惰性读取(env 在调用时取值):模块顶常量会在 .env 加载前冻结(ESM import 提升),
// 脚本先 loadEnv 再 import 也救不了——401 错配(key 发往默认端点)的存量隐患由此根除。
const model = () => process.env['LLM_MODEL'] ?? process.env['DEEPSEEK_MODEL'] ?? 'MiniMax-M2'
const base = () => (process.env['LLM_BASE_URL'] ?? process.env['DEEPSEEK_BASE_URL'] ?? 'https://api.minimax.io/v1').replace(/\/$/, '')

/**
 * Token 用量累计器(OpenAI 兼容 usage 映射)。nightly real-LLM 成本证据(Issue #22
 * `gotry_m3_nightly_run_v1.cost_usd`)的唯一测量来源——成本不允许凭空断言,只允许
 * 这里实测出的 tokens × 封存价表换算;responsesMissingUsage > 0 时成本不可证,调用方必须 fail-closed。
 */
export interface LlmUsageTracker {
  calls: number
  inputTokens: number
  outputTokens: number
  inputCacheHitTokens: number
  inputCacheMissTokens: number
  responsesMissingUsage: number
}

function emptyUsage(): LlmUsageTracker {
  return { calls: 0, inputTokens: 0, outputTokens: 0, inputCacheHitTokens: 0, inputCacheMissTokens: 0, responsesMissingUsage: 0 }
}

/** 单次请求(连接→响应头→正文读完)的默认总预算:对推理模型足够宽松,只兜「连上了却永不应答」的卡死。 */
export const DEFAULT_LLM_TIMEOUT_MS = 300_000
/**
 * 超时上限 = 2^31-1 ms(≈24.8 天)。Node 对更大的延迟会溢出并**悄悄改成 1ms**
 * (TimeoutOverflowWarning),即「配得越大越立刻超时」——所以必须夹住,绝不原样透传。
 */
const MAX_LLM_TIMEOUT_MS = 2_147_483_647

/**
 * chat() 的请求级选项。timeoutMs 压过环境变量 GOTRY_LLM_TIMEOUT_MS;signal 由调用方持有并与
 * 超时合并(AbortSignal.any)——任一先触发就终止本次请求,落成 LlmRequestError。
 */
export interface LlmRequestOptions {
  timeoutMs?: number
  signal?: AbortSignal
}

/** 只认十进制正整数(数值或纯数字串);其余(0/负数/小数/NaN/带单位/空串)一律 undefined——绝不退化成「无超时」。 */
function parseTimeoutMs(raw: unknown): number | undefined {
  const n = typeof raw === 'string' ? (/^\d+$/.test(raw.trim()) ? Number(raw.trim()) : Number.NaN) : raw
  return typeof n === 'number' && Number.isSafeInteger(n) && n > 0 ? Math.min(n, MAX_LLM_TIMEOUT_MS) : undefined
}

/** 解析顺序:本次调用显式值 > 环境变量 GOTRY_LLM_TIMEOUT_MS(调用时取值,同 base()/model())> 默认值。 */
export function resolveLlmTimeoutMs(callMs?: number): number {
  return parseTimeoutMs(callMs) ?? parseTimeoutMs(process.env['GOTRY_LLM_TIMEOUT_MS']) ?? DEFAULT_LLM_TIMEOUT_MS
}

export type LlmRequestFailureCode = 'timeout' | 'aborted'

/**
 * chat() 请求被截断(超时 / 调用方取消)的类型化失败——不是挂起,也不会被吞。
 * 与既有错误形态一致,而非另起一套:
 *  - message 沿用本模块 `llm <kind>: <detail>` 约定(同 `llm 429: …`),只读 .message 的调用方
 *    (nightly-evidence / persona-sim / time-eval --real)原样可用;
 *  - name 取平台既有名 TimeoutError / AbortError(AbortSignal.timeout 与手动 abort 抛的同名),
 *    persona-sim、channel-probe 等按 name 分类的代码零改动即可识别;
 *  - cause 保留 fetch 抛出的原始错误(调用方自定义的 abort reason 也在其中)。
 * HTTP 非 2xx(`llm <status>`)、DNS/连接重置、坏 JSON 仍是原样的普通 Error——只改写「被我们的 signal 终止」的失败。
 */
export class LlmRequestError extends Error {
  readonly code: LlmRequestFailureCode
  /** 本次生效的超时预算;仅 code === 'timeout' 有值 */
  readonly timeoutMs: number | undefined

  constructor(code: LlmRequestFailureCode, detail: string, options: { cause?: unknown; timeoutMs?: number } = {}) {
    super(`llm ${code}: ${detail}`, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = code === 'timeout' ? 'TimeoutError' : 'AbortError'
    this.code = code
    this.timeoutMs = options.timeoutMs
  }
}

interface ChatCompletion {
  choices: Array<{ message: { content: string } }>
  usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_cache_hit_tokens?: number; prompt_cache_miss_tokens?: number }
}

/**
 * 发一次请求并读完正文。**同一个 signal 贯穿 fetch 与 res.json()/res.text()**,所以超时覆盖整个请求
 * (含「响应头已到、正文卡住」与「非 2xx 的错误正文卡住」),调用方取消同理。
 * 只有「被我们的 signal 终止」才改写成 LlmRequestError;其余错误原样上抛。
 */
async function requestCompletion(
  url: string,
  init: { headers: Record<string, string>; body: string },
  request: LlmRequestOptions,
): Promise<{ ok: true; data: ChatCompletion } | { ok: false; status: number; text: string }> {
  const timeoutMs = resolveLlmTimeoutMs(request.timeoutMs)
  const timeout = AbortSignal.timeout(timeoutMs)
  const signal = request.signal ? AbortSignal.any([request.signal, timeout]) : timeout
  try {
    const res = await fetch(url, { method: 'POST', headers: init.headers, body: init.body, signal })
    if (!res.ok) return { ok: false, status: res.status, text: await res.text() }
    return { ok: true, data: await res.json() as ChatCompletion }
  } catch (error) {
    if (!signal.aborted) throw error
    // AbortSignal.any 的 reason 是最先触发的那个源的 reason:等于超时信号的 reason 即超时先到,否则是调用方取消
    if (timeout.aborted && signal.reason === timeout.reason) {
      throw new LlmRequestError('timeout', `no complete response within ${timeoutMs}ms (GOTRY_LLM_TIMEOUT_MS)`, { cause: error, timeoutMs })
    }
    throw new LlmRequestError('aborted', "request cancelled by the caller's AbortSignal", { cause: error })
  }
}

async function chat(
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
  json: boolean,
  usage?: LlmUsageTracker,
  request: LlmRequestOptions = {},
): Promise<string> {
  const key = process.env['LLM_API_KEY'] ?? process.env['DEEPSEEK_API_KEY']
  if (!key) throw new Error('LLM_API_KEY 未设置(兼容 DEEPSEEK_API_KEY 别名)——真 LLM 路径不可用,请回退 mock(ADR-8)')
  const reply = await requestCompletion(`${base()}/chat/completions`, {
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model: model(),
      messages,
      ...(json ? { response_format: { type: 'json_object' } } : {}),
      temperature: json ? 0 : 0.7,
    }),
  }, request)
  if (!reply.ok) throw new Error(`llm ${reply.status}: ${reply.text.slice(0, 300)}`)
  const data = reply.data
  if (usage) {
    usage.calls += 1
    const u = data.usage
    if (u && Number.isFinite(u.prompt_tokens) && Number.isFinite(u.completion_tokens)) {
      usage.inputTokens += u.prompt_tokens ?? 0
      usage.outputTokens += u.completion_tokens ?? 0
      usage.inputCacheHitTokens += u.prompt_cache_hit_tokens ?? 0
      // 无缓存明细的 provider:全部输入按 miss 记(随后按 peak miss 价换算,只高不低)
      usage.inputCacheMissTokens += u.prompt_cache_miss_tokens ?? (u.prompt_tokens ?? 0)
    } else {
      usage.responsesMissingUsage += 1
    }
  }
  const raw = data.choices[0]?.message?.content ?? ''
  // 推理模型(MiniMax-M2 等):剥 <think> 块,只留正文;未闭合时留全文由上层容错
  return raw.replace(/<think>[\s\S]*?<\/think>/g, '').trim() || raw
}

/** 从模型输出稳健地抠出 JSON 对象(容忍围栏/前后文) */
function parseJsonBlock(text: string): Record<string, unknown> | null {
  const m = text.match(/\{[\s\S]*\}/)
  if (!m) return null
  try {
    return JSON.parse(m[0]) as Record<string, unknown>
  } catch {
    return null
  }
}

const FACTS_SYSTEM = `你是旅行规划的事实抽取器。从对话中抽取两类事实并以 JSON 返回:
{"calendar": {"year": 数字, "assertedWeekdays": {"YYYY-MM-DD": "mon|tue|wed|thu|fri|sat|sun"}},
 "profile": {"workWindow": {"homeTzOffsetMin": 数字(仅 legacy v1;用户未明确时可省略), "startMin": 数字, "endMin": 数字, "workdays": [0,1,2,3,4], "evidence": "用户原话"},
              "companions": ["..."], "budgetTier": "economy|comfort|convenience",
              "bookedResources": [{"kind": "flight|hotel", "ref": "...", "window": "..."}]}}
只放用户明确说过的事实;没有的字段省略。分钟数从 HH:MM 换算;用户未明确说 numeric offset 时不要猜、不要输出 homeTzOffsetMin;v2 pack 的 IANA home zone 属于数据层权威。
**休假语义(关键)**:用户说「请假/年假/不用办公/休假」→ workWindow 输出 {"vacation": true}(不是省略!省略会触发重复追问);只有用户明确给了工作时间才输出完整 workWindow 对象。只输出 JSON。`

const SKELETON_SYSTEM = `你是行程骨架抽取器。从对话中抽取行程的**骨架**——段(移动)与锚点,不包含任何班次数据(班次来自数据层,你不要编造时刻/价格/航班号)。
输出 JSON:{"scenario":"erhai|workation|yunnan|generic","segments":[{"id":"f1","role":"choice|fixed","route":"HKG->HKT","dateHint":"2026-07-18","anchors":{"arriveByMin":885}}]}
规则:每个跨城移动一段;锚点只放用户明说或必然的(如"当天到"→arriveByMin 23:59=1439);时刻用当日分钟。
scenario 判定:「洱海/大理/千岛湖/太湖+选目的地」→erhai(候选集);「普吉/workation/远程办公+多城链」→workation(五段链);「云南/大理丽江」→yunnan;不确定→generic。只输出 JSON。`

/**
 * request:本端口每次 chat() 共用的请求级选项(timeoutMs / signal)。signal 是端口级取消——
 * 调用方可借它在会话/批次截止时真正掐断在途请求,而不是放着它继续挂在 provider 上。
 */
export function createOpenAICompatLlm(flightPackPath?: string, clock: () => Date = () => new Date(), request: LlmRequestOptions = {}): LlmPort & { usage: LlmUsageTracker } {
  const pack = flightPackPath
  const usage = emptyUsage()
  const historyText = (h: Turn[]) => h.map(t => `${t.role === 'user' ? '用户' : '助手'}: ${t.text}`).join('\n')
  // 时间锚点卡:每条抽取链路都带上「今天」——legacy 路径此前无时间注入,
  // 过期/相对日期语义全靠它(算术在 time-anchor 层,LLM 只查卡)。
  const anchorContext = () => `时间锚点卡:\n${buildTimeAnchor(clock()).card}`
  return {
    async extractFacts(history) {
      const out = await chat(
        [{ role: 'system', content: FACTS_SYSTEM }, { role: 'user', content: `${anchorContext()}\n\n${historyText(history)}` }],
        true,
        usage,
        request,
      )
      const obj = parseJsonBlock(out)
      if (!obj) return { assumptions: [] }
      const calendar = obj['calendar'] as Partial<CalendarState> | undefined
      const profile = obj['profile'] as Partial<TravelerProfile> | undefined
      const assumptions = Object.keys(profile ?? {}).map(f => ({ field: f, source: 'user-verbatim' as const }))
      return { calendar, profile, assumptions }
    },
    async extractSpec(history, state) {
      // 架构(ADR-10):LLM 只产骨架与锚点;班次数据永远来自能力层(数据包/未来实时API)
      const context = `${anchorContext()}\n已断言日历:${JSON.stringify(state.calendar.assertedWeekdays)}\nprofile:${JSON.stringify(state.profile)}`
      const out = await chat(
        [{ role: 'system', content: SKELETON_SYSTEM }, { role: 'user', content: `${context}\n\n${historyText(history)}` }],
        true,
        usage,
        request,
      )
      const skeleton = parseJsonBlock(out)
      if (!skeleton || !Array.isArray(skeleton['segments']) || (skeleton['segments'] as unknown[]).length === 0) return null
      // 能力层装数据:航班包提供 services;骨架按段 id 合并锚点
      if (!pack) return null
      const { readFile } = await import('node:fs/promises')
      const scenario = String(skeleton['scenario'] ?? 'generic')
      // 场景→数据包路由(薄壳段3:意图决定装哪个包,而非永远装通用包)
      // generic 不装包——意图不明确时不进求解,让循环继续访谈(ADR-10:翻译不造数)
      if (scenario === 'generic') return null
      const packByScenario: Record<string, string> = {
        erhai: pack.replace('flights_2026.json', 'golden_erhai.json'),
        workation: pack, // 五段链
        yunnan: pack.replace('flights_2026.json', 'yunnan-pack.json'),
      }
      const packPath = packByScenario[scenario]
      if (!packPath) return null
      let packSpec: JourneySpecTS
      try {
        if (scenario === 'erhai') {
          // 洱海 = 候选集场景:不装五段链,返回洱海候选 spec 的轻量标记(由引擎的候选求解处理;
          // 循环层看到 scenario=erhai 时走 solveChoiceSegment 而非 solveUnified)
          return { segments: [], note: 'erhai-candidates', budgetCny: 3000 } as unknown as JourneySpecTS
        }
        packSpec = parseFlightPackToSpec(JSON.parse(await readFile(packPath, 'utf-8')))
      } catch (e) {
        // issue #620:数据包被 parse 边界拒收时,原因必须留痕——否则用户只看到
        // 「骨架还不完整」,运维看不到是哪个包的哪个字段把求解面挡住了。
        const err = e as Error & { code?: string }
        console.error(`[gotry] extractSpec: 数据包不可用 ${packPath}(${err.code ?? 'parse_failed'}):`, (err.message ?? '').slice(0, 200))
        return null
      }
      const anchorsById = new Map<string, Record<string, unknown>>(
        (skeleton['segments'] as Array<Record<string, unknown>>).map(s => [String(s['id'] ?? ''), (s['anchors'] ?? {}) as Record<string, unknown>]))
      for (const seg of packSpec.segments) {
        const a = anchorsById.get(seg.id) as { arriveByMin?: number } | undefined
        if (a?.arriveByMin !== undefined) seg.anchors = { arriveByMin: a.arriveByMin }
      }
      packSpec = mergeProfileWorkWindow(packSpec, state.profile.workWindow)
      packSpec.budgetCny = 9000
      return packSpec
    },
    async extractSlots(history, now?: Date): Promise<TravelSlotExtraction | null> {
      // now 可注入(评测固定锚点);过期判定在 flagExpiredSlots(代码层),模型只管逐字抽取
      const anchor = buildTimeAnchor(now ?? clock())
      const out = await chat(
        [{ role: 'system', content: buildSlotSystem(anchor) }, { role: 'user', content: historyText(history) }],
        true,
        usage,
        request,
      )
      const obj = parseJsonBlock(out)
      if (!obj) return null
      // language 判定归代码层(detectLanguage),模型输出仅供参考;过期判定同在代码层
      const ext = normalizeExtraction(obj, history.map(t => t.text).join('\n'))
      return ext ? flagExpiredSlots(ext, anchor) : null
    },
    async polishQuestion(q: InterviewQuestion) {
      const out = await chat(
        [{ role: 'system', content: '把旅行规划的追问润色得更自然,保留全部信息(含为什么问),一两句话,不要加表情。' },
         { role: 'user', content: `【${q.key}】${q.text}(为什么问:${q.why})` }],
        false,
        usage,
        request,
      )
      return out.trim() || `【${q.key}】${q.text}`
    },
    usage,
  }
}
