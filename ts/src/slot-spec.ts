/**
 * 槽位→日期解析层(D-10 切片 A):把 travel_slot_extraction.v1 的逐字时间表达
 * 在代码层换算为绝对日期——「tool-owned dates」的执行面。
 *
 * ADR-12 复审结论(2026-08-27,D-10 赎回触发):设计成立,但解析范围必须**有界**——
 * 只解析锚点卡词表内的表达(今天/明天/后天/大后天/本周X/下周X/下下周X/下个月初|中旬|下旬)
 * 与绝对表达(ISO/点分/中文月日,parseAbsoluteDate)+ 槽位约定后缀「+N」;
 * 词表外(近期/这阵子/next Monday/英文月名…)一律 unresolved 逐字保留,
 * 不做开放式中文相对日期解析(ADR-12 被拒备选:维护黑洞)。
 *
 * 本层是纯函数:不碰求解器、不改入参;工具查询/spec 一致性闸的接线属后续切片。
 */

import { parseAbsoluteDate, ymd, type TimeAnchor } from './time-anchor.ts'
import type { TravelSlotExtraction } from './travel-slots.ts'

export type SlotDateKind = 'absolute' | 'card' | 'unresolved'

export interface SlotDateResolution {
  /** 用户原话(逐字) */
  raw: string
  /** 换算结果 YYYY-MM-DD;unresolved 时 null */
  date: string | null
  kind: SlotDateKind
}

const WEEKDAY_ZH: Record<string, number> = { 日: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6 }

function addDaysYmd(today: string, n: number): string {
  const [y, m, d] = today.split('-').map(Number)
  return ymd(new Date(y, m - 1, d + n))
}

/** 「下周五+3」「8.20+2天」后缀:base + N 天(槽位规则 5/6 的拼接约定) */
function splitPlusSuffix(expr: string): { base: string; plusDays: number } {
  const m = expr.match(/^(.*?)\+(\d+)天?$/)
  if (m && m[1]) return { base: m[1], plusDays: Number(m[2]) }
  return { base: expr, plusDays: 0 }
}

/** 锚点卡近邻日词表(今天/明天/后天/大后天)→ 相对今天的偏移天数;词表外 null */
function neighborDayOffset(expr: string): number | null {
  if (expr === '今天') return 0
  if (expr === '明天') return 1
  if (expr === '后天') return 2
  if (expr === '大后天') return 3
  return null
}

/** 锚点卡词表周表达(本周X/下周X/下下周X)→ 相对今天的偏移天数;词表外 null。周一分界,与锚点卡一致 */
function weekdayOffsetDays(expr: string, today: string): number | null {
  const m = expr.match(/^(本|下|下下)周([日一二三四五六])$/)
  if (!m || !m[2]) return null
  const target = WEEKDAY_ZH[m[2]]
  if (target === undefined) return null
  const [y, mm, d] = today.split('-').map(Number)
  const todayMonOffset = (new Date(y, mm - 1, d).getDay() + 6) % 7
  const targetMonOffset = (target + 6) % 7
  const weekShift = m[1] === '本' ? 0 : m[1] === '下' ? 7 : 14
  return weekShift + targetMonOffset - todayMonOffset
}

/** 锚点卡月分段词表(下个月初/中旬/下旬)→ 该分段首日;词表外 null(保守取首日,宁可早不可晚) */
function monthFragmentDate(expr: string, today: string): string | null {
  if (!['下个月初', '下个月中旬', '下个月下旬'].includes(expr)) return null
  const [y, m] = today.split('-').map(Number)
  const day = expr === '下个月初' ? 1 : expr === '下个月中旬' ? 11 : 21
  return ymd(new Date(y, m, day))
}

/**
 * 逐字时间表达 → 绝对日期。顺序:绝对表达 → 「+N」后缀拆解 → 锚点卡词表 → unresolved。
 * kind 告知下游证据等级:absolute/card 可直接用于工具查询;unresolved 必须原文透传给人/模型。
 */
export function resolveSlotDate(expr: string, anchor: TimeAnchor): SlotDateResolution {
  const raw = expr.trim()
  const year = Number(anchor.today.slice(0, 4))

  const absolute = parseAbsoluteDate(raw, year)
  if (absolute) return { raw, date: absolute, kind: 'absolute' }

  const { base, plusDays } = splitPlusSuffix(raw)
  const baseAbs = parseAbsoluteDate(base, year)
  if (baseAbs) return { raw, date: addDaysYmd(baseAbs, plusDays), kind: 'absolute' }

  const month = monthFragmentDate(base, anchor.today)
  if (month) return { raw, date: addDaysYmd(month, plusDays), kind: 'card' }

  const neighbor = neighborDayOffset(base)
  if (neighbor !== null) return { raw, date: addDaysYmd(anchor.today, neighbor + plusDays), kind: 'card' }

  const offset = weekdayOffsetDays(base, anchor.today)
  if (offset !== null) return { raw, date: addDaysYmd(anchor.today, offset + plusDays), kind: 'card' }

  return { raw, date: null, kind: 'unresolved' }
}

/** 各域的日期槽位字段(解析覆盖面:主日期 + 回程/退房) */
const DATE_FIELDS: Record<string, string[]> = {
  requisition: ['start_date', 'end_date'],
  flight: ['departure_date', 'return_date'],
  hotel: ['check_in_date', 'check_out_date'],
}

export interface ResolvedSlots {
  requisition?: { start_date?: SlotDateResolution; end_date?: SlotDateResolution }
  flight?: { departure_date?: SlotDateResolution; return_date?: SlotDateResolution }
  hotel?: { check_in_date?: SlotDateResolution; check_out_date?: SlotDateResolution }
  /** 词表外表达清单(field = "<domain>.<field>"),逐字保留等下游(人/模型)裁决 */
  unresolved: Array<{ field: string; raw: string }>
}

/** 整张抽取的日期解析(纯函数,不改入参):只处理日期槽位,目的地/偏好等不在此层 */
export function resolveSlots(ext: TravelSlotExtraction, anchor: TimeAnchor): ResolvedSlots {
  const out: ResolvedSlots = { unresolved: [] }
  for (const domain of ext.domains) {
    const slots = ext.slots[domain] as Record<string, unknown> | undefined
    if (!slots) continue
    for (const field of DATE_FIELDS[domain] ?? []) {
      const value = slots[field]
      if (typeof value !== 'string') continue
      const res = resolveSlotDate(value, anchor)
      const bucket = (out[domain as keyof Omit<ResolvedSlots, 'unresolved'>] ??= {}) as Record<string, SlotDateResolution>
      bucket[field] = res
      if (res.kind === 'unresolved') out.unresolved.push({ field: `${domain}.${field}`, raw: res.raw })
    }
  }
  return out
}

export interface SpecDateMismatch {
  /** spec 侧位置,如 segments[0].date */
  specAt: string
  field: string
  specDate: string
  slotDate: string
}

/**
 * spec ↔ 槽位日期一致性闸(ADR-10 翻译≠造数的执行面):LLM 产出的 JourneySpecTS 日期
 * 与代码层换算的槽位日期逐项比对,分歧即返回 mismatch(供渲染 red-flag/追问),不静默采信。
 *
 * 范围边界(2026-08-28 巡检修正):槽位 v1 只有 trip 级主日期(start/departure/check-in),
 * **只校验恰好一个带日期段的 spec**;多段行程的逐段日期没有槽位真值可比(不比,不造假阳性
 * ——金标准六段行程曾被全段误判分歧,求解被永久拦截)。spec 无日期或槽位 unresolved 不参与。
 */
export function specDateMismatches(
  spec: { segments?: Array<{ date?: string }> },
  resolved: ResolvedSlots,
): SpecDateMismatch[] {
  const mismatches: SpecDateMismatch[] = []
  const primary: Array<{ field: string; res?: SlotDateResolution }> = [
    { field: 'requisition.start_date', res: resolved.requisition?.start_date },
    { field: 'flight.departure_date', res: resolved.flight?.departure_date },
    { field: 'hotel.check_in_date', res: resolved.hotel?.check_in_date },
  ]
  const dated = primary.filter((p): p is { field: string; res: SlotDateResolution } => p.res?.date != null)
  if (dated.length === 0) return mismatches
  const datedSegs = (spec.segments ?? []).filter(s => typeof s.date === 'string' && s.date)
  if (datedSegs.length !== 1) return mismatches // 多段(或零段)无逐段真值,闸不判
  const seg = datedSegs[0]!
  const slotDates = new Set(dated.map(s => s.res.date as string))
  if (!slotDates.has(seg.date as string)) {
    mismatches.push({
      specAt: `segments[${(spec.segments ?? []).indexOf(seg)}].date`,
      field: dated.map(s => s.field).join('|'),
      specDate: seg.date as string,
      slotDate: [...slotDates].join('|'),
    })
  }
  return mismatches
}
