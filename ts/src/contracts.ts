/**
 * Stage 1 契约层(S1,docs/stage1-top-down-design.md §2)——顶层数据与工具面契约。
 *
 * 自顶向下纪律:本文件是唯一权威契约。实现(mock 循环/求解器挂载/真 LLM)都向这里对齐;
 * 契约变更需走设计文档升版,不随实现漂移。
 * 责任铁律:LLM 只做问句组织/翻译/解释;判定与算术永远是确定性组件。
 */

import type { JourneySpecTS } from './unified.ts'

// ---- TripState:会话状态契约(一切组件围绕它读写) --------------------------------

export interface CalendarState {
  year: number
  /** 一次断言终身使用:{"2026-07-17": "fri"}——Kimi 三轮日历混乱的解药 */
  assertedWeekdays: Record<string, 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun'>
}

export interface WorkWindowProfile {
  homeTzOffsetMin: number
  startMin: number
  endMin: number
  workdays: number[]
  /** 证据:用户原话(P0 反幻觉,与动机画像同规) */
  evidence: string
}

export interface TravelerProfile {
  workWindow?: WorkWindowProfile
  companions?: string[]
  budgetTier?: 'economy' | 'comfort' | 'convenience'
  /** 已订资源(航班/酒店)——Kimi 复盘:第 6 轮才被问出的关键事实 */
  bookedResources?: Array<{ kind: 'flight' | 'hotel'; ref: string; window?: string }>
  motivation?: { weights: Record<string, number>; evidence: string[] }
}

export interface GateOption {
  label: string
  tradeOff?: string
}

export interface Gate {
  id: string
  question: string
  options: GateOption[]
  /** 回答后回填 */
  answer?: string
}

export interface WishEntry {
  name: string
  reason: string
  conditions: Record<string, unknown>
  addedAt?: string
}

export interface TripState {
  calendar: CalendarState
  profile: TravelerProfile
  spec?: JourneySpecTS
  solve?: SolveResult
  gates: Gate[]
  wishes: WishEntry[]
}

// ---- 求解结果(unified 求解器输出的契约化引用) ----------------------------------

export interface SolveResult {
  feasible: boolean
  money_cny?: number
  legs?: Array<Record<string, unknown> & { leg: string }>
  red_flags?: string[]
  unsat_core?: string[]
  suggestions?: Array<{ relax: string; money_cny?: number }>
  work_window_exclusions?: Array<{ segment: string; option: string; reason: string }>
  skeleton_notes?: string[]
  verdicts?: Array<Record<string, unknown>>
  recommended?: string | null
}

// ---- 工具面契约(五个;dsh 插件按此注册) -----------------------------------------

export interface Turn {
  role: 'user' | 'assistant'
  text: string
}

/** ADR-9:访谈由缺失字段驱动(确定性),LLM 只润色问句 */
export interface InterviewQuestion {
  key: string                    // 对应 profile 的缺失字段,如 "workWindow" / "bookedResources"
  text: string
  why: string                    // 为什么问(Kimi 复盘:不解释的追问=审讯)
  options?: GateOption[]
}

export interface GotryInterviewNextIO {
  input: { state: TripState; brief?: string }
  output: { questions: InterviewQuestion[]; missing: string[] }
}

export interface SpecAssumption {
  field: string
  value: unknown
  source: 'user-verbatim' | 'inferred' | 'default'   // inferred 必须在渲染时声明
}

export interface GotrySpecExtractIO {
  input: { history: Turn[]; state: TripState }
  output: { spec: JourneySpecTS; assumptions: SpecAssumption[]; calendarConflicts?: string[] }
}

export interface GotrySolveIO {
  input: { spec: JourneySpecTS }
  output: { result: SolveResult }
}

export interface GotryRenderIO {
  input: { state: TripState }
  output: { replyMd: string; cardsMd: string[]; gates: Gate[] }
}

export interface GotryWishPoolIO {
  input: { entry: WishEntry }
  output: { added: boolean; total: number }
}

/** 工具注册表:名字 → IO 类型(dsh 插件按此生成 parameters/output schema) */
export const TOOL_CONTRACTS = {
  'gotry_interview_next': {} as GotryInterviewNextIO,
  'gotry_spec_extract': {} as GotrySpecExtractIO,
  'gotry_solve': {} as GotrySolveIO,
  'gotry_render': {} as GotryRenderIO,
  'gotry_wish_pool_add': {} as GotryWishPoolIO,
} as const

export type ToolName = keyof typeof TOOL_CONTRACTS

// ---- wire schema(dsh 注册用的 JSON Schema 面;type:'json' 根 + 关键字段文档) ----

export const TRIP_STATE_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    calendar: {
      type: 'object', additionalProperties: true,
      description: '年份与已断言的星期映射;一次断言终身使用,冲突必须显式指出',
    },
    profile: {
      type: 'object', additionalProperties: true,
      description: 'workWindow(带 evidence)/companions/budgetTier/bookedResources/motivation',
    },
    spec: { type: 'json', description: '统一行程模型 JourneySpec(见 unified.ts)' },
    solve: { type: 'json', description: '求解结果(锚点/排除/红旗/建议)' },
    gates: {
      type: 'array',
      description: '待决问题,只能是选择题',
      items: {
        type: 'object', additionalProperties: true,
        properties: { id: { type: 'string' }, question: { type: 'string' } },
      },
    },
    wishes: { type: 'array', description: '「下一次出发」清单', items: { type: 'object', additionalProperties: true } },
  },
  required: ['calendar', 'profile', 'gates', 'wishes'],
} as const
