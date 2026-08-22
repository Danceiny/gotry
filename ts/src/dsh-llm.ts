/**
 * 真 LlmPort(S4 工程半段):DeepSeek OpenAI 兼容接口的适配器。
 * 零新依赖(node 内建 fetch);DEEPSEEK_API_KEY 到位即插即用——
 * 无 key 时抛出明确错误,replay-real 自动回退 mock(ADR-8 的另一面:真智能可选)。
 * 责任铁律不变:本适配器只做翻译/润色/解释,判定与算术在确定性组件。
 */

import type { LlmPort } from './loop.ts'
import type { InterviewQuestion, TravelerProfile, TripState, Turn, CalendarState } from './contracts.ts'
import type { JourneySpecTS } from './unified.ts'

const MODEL = process.env['DEEPSEEK_MODEL'] ?? 'deepseek-chat'
const BASE = process.env['DEEPSEEK_BASE_URL'] ?? 'https://api.deepseek.com'

async function chat(messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>, json: boolean): Promise<string> {
  const key = process.env['DEEPSEEK_API_KEY']
  if (!key) throw new Error('DEEPSEEK_API_KEY 未设置——真 LLM 路径不可用,请回退 mock(ADR-8)')
  const res = await fetch(`${BASE}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model: MODEL,
      messages,
      ...(json ? { response_format: { type: 'json_object' } } : {}),
      temperature: json ? 0 : 0.7,
    }),
  })
  if (!res.ok) throw new Error(`deepseek ${res.status}: ${(await res.text()).slice(0, 300)}`)
  const data = await res.json() as { choices: Array<{ message: { content: string } }> }
  return data.choices[0]?.message?.content ?? ''
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
只放用户明确说过的事实;没有的字段省略。分钟数从 HH:MM 换算;UTC+4 → homeTzOffsetMin=240。只输出 JSON。`

const SPEC_SYSTEM = `你是行程翻译器。把对话中的行程诉求翻译为统一行程模型 JSON(JourneySpec):
{"segments": [{"id": "f1", "role": "choice|fixed", "date": "说明", "anchors": {"arriveByMin": 数字或省略},
  "options": [{"id": "班次或方案", "move": {"hub": "", "services": [{"id": "", "depMin": 数字, "arrMin": 数字, "priceCny": 数字}],
   "bufferMin": 90, "originTransferMin": 60, "destTransferMin": 60, "tzOffsetMin": 0, "originTzOffsetMin": 480,
   "redEye": false, "redEyeDurationMin": 0}}]}]}
规则:时间用当日分钟(HH:MM 换算);信息不足宁可省略字段也不要编造;
已订资源是 fixed 段;日期星期若与 calendar 断言冲突,输出 "calendarConflicts"。只输出 JSON。`

export function createDeepSeekLlm(): LlmPort {
  const historyText = (h: Turn[]) => h.map(t => `${t.role === 'user' ? '用户' : '助手'}: ${t.text}`).join('\n')
  return {
    async extractFacts(history) {
      const out = await chat(
        [{ role: 'system', content: FACTS_SYSTEM }, { role: 'user', content: historyText(history) }],
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
      const context = `已断言日历:${JSON.stringify(state.calendar.assertedWeekdays)}\nprofile:${JSON.stringify(state.profile)}`
      const out = await chat(
        [{ role: 'system', content: SPEC_SYSTEM }, { role: 'user', content: `${context}\n\n${historyText(history)}` }],
        true,
      )
      const obj = parseJsonBlock(out)
      if (!obj || !Array.isArray(obj['segments'])) return null
      return obj as unknown as JourneySpecTS
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
