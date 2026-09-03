/**
 * Per-turn routing & time allocation (ADR-24 v2).
 *
 * 用户主观时间是产品路径唯一的预算:复杂度决定**出口结构**(converge /
 * handoff),时间只是在所选结构内的资源分配。路由在 user/message 落地时
 * 一次完成,纯函数、零 LLM、零 IO——控制面判定必须是确定性组件
 * (stage1 责任铁律;ADR-9 同型先例),且不能花它要分配的资源。
 *
 * Tier 0(消息内禀)是 v1 的全部规则输入;Tier 1(账本读回)只在
 * handoff 落单时用于工单上下文,不参与分类。`loop.ts` 的 isComplex 是
 * S5 循环架构内的访谈后复核,不在产品路径上,不进本层。
 */

export type TaskClass = 'quick' | 'sync-planning' | 'deep-planning'

export type TurnExit = 'converge' | 'handoff'

export interface TurnPolicy {
  /** 软阈:注入收敛/转出提示,不拦截。 */
  softMs: number
  /** 硬阈:拒绝后续工具派发,按 exit 语义出口。 */
  hardMs: number
  /** 硬阈出口:converge=用已有证据作答;handoff=落工单转后台并告知用户。 */
  exit: TurnExit
}

/** v1 阈值表:数据不是代码;评测/部署换表不换执行器。 */
export const TURN_POLICIES: Record<TaskClass, TurnPolicy> = {
  // quick:实际上限只是安全网——quick 类历史上没有发散记录。
  quick: { softMs: 120_000, hardMs: 180_000, exit: 'converge' },
  'sync-planning': { softMs: 300_000, hardMs: 600_000, exit: 'converge' },
  // deep-planning:同步窗口只够"摸底 + 落单承诺",到点必须转后台。
  'deep-planning': { softMs: 120_000, hardMs: 240_000, exit: 'handoff' },
}

export const TURN_HANDOFF_ETA_LABEL = '约 1 小时'

/** 约束词表:只作弱信号(命中≥2 才可能推 deep);新增词=加一行+一测。 */
export const TURN_CONSTRAINT_LEXICON = [
  '婚礼', '婚宴', '回门', '订婚',
  'IRW', 'irw',
  '请假', '年假', '调休', '额度',
  '签证', '同行', '伴侣', '亲子', '带娃', '父母', '团建', '出差',
  '红眼', '中转', '联程', '多城',
] as const

export interface TurnSignals {
  messageLength: number
  /** 消息内的绝对日期(已过 1-12/1-31 校验)。 */
  absoluteDates: Array<{ year: number | null; month: number; day: number }>
  /** 绝对日期≥2 时为极差天数;否则为跨度词天数;都没有则 null。 */
  spanDays: number | null
  /** 命中的约束词(去重,保留词表序)。 */
  constraintHits: string[]
}

const CN_DIGITS: Record<string, number> = {
  一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10,
}

function dayCount(year: number | null, month: number, day: number): number {
  // 无年份时按平年锚定:跨度计算只需要差值,月份跨年场景 v1 不覆盖。
  const y = year ?? 1970
  return Date.UTC(y, month - 1, day) / 86_400_000
}

/** 跨度词 → 估算天数;按声明强度取第一个命中,v1 不做组合。 */
function spanWordDays(message: string): number | null {
  if (/十几天/.test(message)) return 12
  if (/半个月/.test(message)) return 15
  if (/一个月/.test(message)) return 30
  const week = message.match(/[一两]个?(?:星期|周)/)
  if (week) return week[0].startsWith('两') ? 14 : 7
  const dayMatch = message.match(/([0-9一二两三四五六七八九十]+)\s*天/)
  if (dayMatch) {
    const raw = dayMatch[1]
    if (/^[0-9]+$/.test(raw)) return Math.min(Number.parseInt(raw, 10), 60)
    if (CN_DIGITS[raw] !== undefined) return Math.min(CN_DIGITS[raw], 60)
  }
  return null
}

export function extractTurnSignals(message: string): TurnSignals {
  const absoluteDates: TurnSignals['absoluteDates'] = []

  // 完整日期先摘除,避免 2026-10-03 再被月/日模式重复计数。
  let rest = message.replace(
    /(?<!\d)(\d{4})[年\-.\/](\d{1,2})[月\-.\/](\d{1,2})日?(?!\d)/g,
    (_all, y: string, m: string, d: string) => {
      const month = Number.parseInt(m, 10)
      const day = Number.parseInt(d, 10)
      if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
        absoluteDates.push({ year: Number.parseInt(y, 10), month, day })
      }
      return ' '
    },
  )
  rest = rest.replace(
    /(?<!\d)(\d{1,2})月(\d{1,2})日?(?!\d)/g,
    (_all, m: string, d: string) => {
      const month = Number.parseInt(m, 10)
      const day = Number.parseInt(d, 10)
      if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
        absoluteDates.push({ year: null, month, day })
      }
      return ' '
    },
  )
  rest = rest.replace(
    /(?<!\d)(\d{1,2})[.\/](\d{1,2})(?!\d)/g,
    (_all, m: string, d: string) => {
      const month = Number.parseInt(m, 10)
      const day = Number.parseInt(d, 10)
      if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
        absoluteDates.push({ year: null, month, day })
      }
      return ' '
    },
  )

  const constraintHits = TURN_CONSTRAINT_LEXICON.filter(word => message.includes(word))

  let spanDays: number | null = null
  if (absoluteDates.length >= 2) {
    const counts = absoluteDates.map(d => dayCount(d.year, d.month, d.day))
    spanDays = Math.max(...counts) - Math.min(...counts)
  } else {
    spanDays = spanWordDays(message)
  }

  return { messageLength: message.length, absoluteDates, spanDays, constraintHits }
}

/**
 * 分类规则(有序,可表测):长跨度或多约束 → deep(转后台);无日期无约束
 * 且短 → quick;其余落默认中间档 sync-planning。误分有界:三态出口保证
 * 最坏结局是"本可当面答的被转了后台"(下一轮可救),而非流死掉。
 */
export function classifyTurn(message: string): TaskClass {
  const s = extractTurnSignals(message)
  if (s.spanDays !== null && s.spanDays >= 7) return 'deep-planning'
  if (s.absoluteDates.length >= 2 && s.constraintHits.length >= 1) return 'deep-planning'
  if (s.constraintHits.length >= 2 && (s.absoluteDates.length >= 1 || s.spanDays !== null)) {
    return 'deep-planning'
  }
  if (s.absoluteDates.length === 0 && s.constraintHits.length === 0 && s.spanDays === null && s.messageLength <= 60) {
    return 'quick'
  }
  return 'sync-planning'
}

export function turnPolicyFor(taskClass: TaskClass): TurnPolicy {
  return { ...TURN_POLICIES[taskClass] }
}
