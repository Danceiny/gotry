/**
 * 真 LlmPort:OpenAI 兼容接口的 provider 中立适配器(DeepSeek/MiniMax-M2 实测)。
 * 零新依赖(node 内建 fetch)。环境变量:LLM_API_KEY/LLM_BASE_URL/LLM_MODEL
 * (兼容旧 DEEPSEEK_* 别名)。MiniMax-M2 是推理模型:输出带 <think> 块,
 * 必须先剥离再解析——JSON 藏在 think 里是常见失败模式。
 * 无 key 时抛出明确错误,replay-real 自动回退 mock(ADR-8)。
 * 责任铁律不变:本适配器只做翻译/润色/解释,判定与算术在确定性组件。
 */

import type { LlmPort } from './loop.ts'
import type { InterviewQuestion, TravelerProfile, TripState, Turn, CalendarState } from './contracts.ts'
import { parseFlightPackToSpec, type JourneySpecTS } from './unified.ts'
import { buildTimeAnchor } from './time-anchor.ts'
import { buildSlotSystem, flagExpiredSlots, normalizeExtraction, type TravelSlotExtraction } from './travel-slots.ts'

// 惰性读取(env 在调用时取值):模块顶常量会在 .env 加载前冻结(ESM import 提升),
// 脚本先 loadEnv 再 import 也救不了——401 错配(key 发往默认端点)的存量隐患由此根除。
const model = () => process.env['LLM_MODEL'] ?? process.env['DEEPSEEK_MODEL'] ?? 'MiniMax-M2'
const base = () => (process.env['LLM_BASE_URL'] ?? process.env['DEEPSEEK_BASE_URL'] ?? 'https://api.minimax.io/v1').replace(/\/$/, '')

async function chat(messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>, json: boolean): Promise<string> {
  const key = process.env['LLM_API_KEY'] ?? process.env['DEEPSEEK_API_KEY']
  if (!key) throw new Error('LLM_API_KEY 未设置(兼容 DEEPSEEK_API_KEY 别名)——真 LLM 路径不可用,请回退 mock(ADR-8)')
  const res = await fetch(`${base()}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model: model(),
      messages,
      ...(json ? { response_format: { type: 'json_object' } } : {}),
      temperature: json ? 0 : 0.7,
    }),
  })
  if (!res.ok) throw new Error(`llm ${res.status}: ${(await res.text()).slice(0, 300)}`)
  const data = await res.json() as { choices: Array<{ message: { content: string } }> }
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
 "profile": {"workWindow": {"homeTzOffsetMin": 数字, "startMin": 数字, "endMin": 数字, "workdays": [0,1,2,3,4], "evidence": "用户原话"},
              "companions": ["..."], "budgetTier": "economy|comfort|convenience",
              "bookedResources": [{"kind": "flight|hotel", "ref": "...", "window": "..."}]}}
只放用户明确说过的事实;没有的字段省略。分钟数从 HH:MM 换算;UTC+4 → homeTzOffsetMin=240。
**休假语义(关键)**:用户说「请假/年假/不用办公/休假」→ workWindow 输出 {"vacation": true}(不是省略!省略会触发重复追问);只有用户明确给了工作时间才输出完整 workWindow 对象。只输出 JSON。`

const SKELETON_SYSTEM = `你是行程骨架抽取器。从对话中抽取行程的**骨架**——段(移动)与锚点,不包含任何班次数据(班次来自数据层,你不要编造时刻/价格/航班号)。
输出 JSON:{"scenario":"erhai|workation|yunnan|generic","segments":[{"id":"f1","role":"choice|fixed","route":"HKG->HKT","dateHint":"2026-07-18","anchors":{"arriveByMin":885}}]}
规则:每个跨城移动一段;锚点只放用户明说或必然的(如"当天到"→arriveByMin 23:59=1439);时刻用当日分钟。
scenario 判定:「洱海/大理/千岛湖/太湖+选目的地」→erhai(候选集);「普吉/workation/远程办公+多城链」→workation(五段链);「云南/大理丽江」→yunnan;不确定→generic。只输出 JSON。`

export function createOpenAICompatLlm(flightPackPath?: string, clock: () => Date = () => new Date()): LlmPort {
  const pack = flightPackPath
  const historyText = (h: Turn[]) => h.map(t => `${t.role === 'user' ? '用户' : '助手'}: ${t.text}`).join('\n')
  // 时间锚点卡:每条抽取链路都带上「今天」——legacy 路径此前无时间注入,
  // 过期/相对日期语义全靠它(算术在 time-anchor 层,LLM 只查卡)。
  const anchorContext = () => `时间锚点卡:\n${buildTimeAnchor(clock()).card}`
  return {
    async extractFacts(history) {
      const out = await chat(
        [{ role: 'system', content: FACTS_SYSTEM }, { role: 'user', content: `${anchorContext()}\n\n${historyText(history)}` }],
        true,
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
      } catch {
        return null
      }
      const anchorsById = new Map<string, Record<string, unknown>>(
        (skeleton['segments'] as Array<Record<string, unknown>>).map(s => [String(s['id'] ?? ''), (s['anchors'] ?? {}) as Record<string, unknown>]))
      for (const seg of packSpec.segments) {
        const a = anchorsById.get(seg.id) as { arriveByMin?: number } | undefined
        if (a?.arriveByMin !== undefined) seg.anchors = { arriveByMin: a.arriveByMin }
      }
      packSpec.workWindow = state.profile.workWindow ? {
        homeTzOffsetMin: state.profile.workWindow.homeTzOffsetMin,
        startMin: state.profile.workWindow.startMin,
        endMin: state.profile.workWindow.endMin,
        workdays: state.profile.workWindow.workdays,
      } : undefined
      packSpec.budgetCny = 9000
      return packSpec
    },
    async extractSlots(history, now?: Date): Promise<TravelSlotExtraction | null> {
      // now 可注入(评测固定锚点);过期判定在 flagExpiredSlots(代码层),模型只管逐字抽取
      const anchor = buildTimeAnchor(now ?? clock())
      const out = await chat(
        [{ role: 'system', content: buildSlotSystem(anchor) }, { role: 'user', content: historyText(history) }],
        true,
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
      )
      return out.trim() || `【${q.key}】${q.text}`
    },
  }
}
