/**
 * Mock LLM(S2,ADR-8):确定性剧本,重放真实对话的智能侧。
 * 它不做任何「聪明事」——只按剧本返回抽取结果;循环架构的正确性由此验证,
 * 与智能质量解耦。S4 接真 LLM 后,本文件留作回归夹具。
 */

import type { LlmPort } from './loop.ts'
import type { InterviewQuestion, TravelerProfile, TripState, Turn, CalendarState } from './contracts.ts'

interface ScriptStep {
  /** 命中条件:用户消息包含此关键词(第一条匹配生效) */
  when: string
  calendar?: Partial<CalendarState>
  profile?: Partial<TravelerProfile>
}

/** 剧本:来自真实 Kimi 对话里用户给出关键事实的时刻 */
const SCRIPT: ScriptStep[] = [
  {
    when: '请给我做机票和酒店的行程规划和推荐',
    calendar: {
      year: 2026,
      assertedWeekdays: {
        '2026-07-17': 'fri', '2026-07-18': 'sat', '2026-07-31': 'fri',
        '2026-08-01': 'sat', '2026-08-09': 'sun', '2026-08-10': 'mon',
      },
    },
    profile: { companions: ['girlfriend(先在普吉)'] },
  },
  {
    when: '工作时间',
    profile: {
      workWindow: {
        homeTzOffsetMin: 240, startMin: 600, endMin: 1140, workdays: [0, 1, 2, 3, 4],
        evidence: '用户原话:我的工作时间是UTC+4的早上10点到下午7点',
      },
    },
  },
  {
    when: '订了酒店',
    profile: {
      bookedResources: [
        { kind: 'hotel', ref: 'The Title East Wing Rawai(7.18-23, 5 晚)', window: '2026-07-18~07-23' },
      ],
    },
  },
]

export function createMockLlm(): LlmPort {
  let stepIdx = 0
  return {
    async extractFacts(history: Turn[], _state: TripState) {
      const last = history[history.length - 1]?.text ?? ''
      // 剧本顺序消费:真实对话里事实按此顺序浮出;未命中则无新事实
      const step = SCRIPT[stepIdx]
      if (step && last.includes(step.when)) {
        stepIdx++
        return {
          calendar: step.calendar,
          profile: step.profile,
          assumptions: Object.keys({ ...step.profile }).map(f => ({ field: f, source: 'user-verbatim' as const })),
        }
      }
      return { assumptions: [] }
    },
    async polishQuestion(q: InterviewQuestion) {
      return `【${q.key}】${q.text}\n(为什么问:${q.why})`
    },
  }
}
