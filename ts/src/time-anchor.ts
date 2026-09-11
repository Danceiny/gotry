/**
 * 时间锚点层(确定性纯函数,零依赖):「今天是哪天、相对日期怎么换算」的算术全部在这里,
 * LLM 只查锚点卡不自算(仓规:算术只在代码层;tool-owned dates 的执行面)。
 *
 * 消费面:
 *  - dsh 成品路径:index.ts 注册 {{time_anchor_card}} 变量,系统时钟;
 *  - legacy 抽取路径:dsh-llm.ts 注入 FACTS/SKELETON/槽位抽取 prompt;
 *  - 评测:time-eval-tests.ts 用固定 now(2026-08-27)保证确定性。
 *
 * 债务(architecture §10 登记):节日锚点表 SPRING_FESTIVAL 硬编码(#274:2026-08-28 扩至 2031,
 * 2026-09-11 扩至 2040,来源=香港天文台公历↔农历转换表);地平线=2040-02-12,
 * 越界后春节锚点静默缺失(已知边界),下次扩表必须在其前完成。
 */

export interface TimeAnchor {
  /** 今天 YYYY-MM-DD(宿主机本地时区) */
  today: string
  /** 今天星期几,如「周四」 */
  todayWeekdayZh: string
  /** 时区标注,固定为 UTC±HH:MM,如 UTC+08:00 / UTC+05:30 */
  tzLabel: string
  /** 注入 prompt 的多行锚点卡文本 */
  card: string
}

export type PlanningDateIntent = 'future' | 'historical'

/**
 * Named-year planning context. It is derived per turn from the current
 * TimeAnchor; it is deliberately not part of TripState so a later turn cannot
 * inherit a stale planning reference date.
 */
export interface PlanningWindow {
  referenceDate: string
  requestedYear: number
  intent: PlanningDateIntent
}

export interface PlanningWindowBounds {
  start: string
  end: string
}

const WEEKDAYS_ZH = ['日', '一', '二', '三', '四', '五', '六'] as const

export function ymd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function addDays(d: Date, n: number): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n)
}

/** ISO 周周一:getDay() 周日=0 归到上周一(-6) */
function weekMonday(d: Date): Date {
  return addDays(d, -((d.getDay() + 6) % 7))
}

/** 春节锚点表(仅此节日漂移大,硬编码;元旦/国庆固定月日,按「下一次发生」算)。
 *  数据口径=农历正月初一(天文日期,非国务院放假安排——后者每年约 11 月才公布次年,
 *  不进本表;表外年份不预估、不编造)。
 *  来源:香港天文台公历↔农历转换表(www.hko.gov.hk,gts/time/calendar/text/files/T{年}e.txt;
 *  2031-2040 段于 2026-09-11 逐条核对,并与 Wikipedia「Chinese New Year」日期表交叉一致)。
 *  D-9/#274:2026-08-28 扩至 2031;2026-09-11 扩至 2040。地平线=2040-02-12,
 *  越界后春节锚点静默缺失(已知边界,time-eval §1c 钉住),下次扩表触发点=2040-02-12 之前。 */
const SPRING_FESTIVAL: Record<number, string> = {
  2026: '2026-02-17',
  2027: '2027-02-06',
  2028: '2028-01-26',
  2029: '2029-02-13',
  2030: '2030-02-03',
  2031: '2031-01-23',
  // ---- #274 扩锚(2026-09-11,香港天文台 T2032e-T2040e 逐条核对) ----
  2032: '2032-02-11',
  2033: '2033-01-31',
  2034: '2034-02-19',
  2035: '2035-02-08',
  2036: '2036-01-28',
  2037: '2037-02-15',
  2038: '2038-02-04',
  2039: '2039-01-24',
  2040: '2040-02-12',
}

export function formatUtcOffsetLabel(utcOffsetMinutes: number): string {
  const sign = utcOffsetMinutes >= 0 ? '+' : '-'
  const abs = Math.abs(utcOffsetMinutes)
  const h = Math.floor(abs / 60)
  const m = abs % 60
  return `UTC${sign}${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}

function tzLabelOf(d: Date): string {
  return formatUtcOffsetLabel(-d.getTimezoneOffset())
}

function weekdayOf(d: Date): string {
  return `周${WEEKDAYS_ZH[d.getDay()]}`
}

/** 一周七天的渲染:周一 2026-08-31|周二 …|周日 … */
function weekRow(label: string, monday: Date): string {
  const days = Array.from({ length: 7 }, (_, i) => {
    const d = addDays(monday, i)
    return `${weekdayOf(d)} ${ymd(d)}`
  })
  return `${label}:${days.join('|')}`
}

/** 固定月日节日的下一次发生(已过则取明年) */
function nextOccurrence(todayYmd: string, year: number, monthDay: string): string {
  const thisYear = `${year}-${monthDay}`
  return thisYear >= todayYmd ? thisYear : `${year + 1}-${monthDay}`
}

export function buildTimeAnchor(now: Date = new Date()): TimeAnchor {
  const today = ymd(now)
  const year = now.getFullYear()
  const monday = weekMonday(now)

  const tomorrow = addDays(now, 1)
  const dayAfter = addDays(now, 2)
  const inThreeDays = addDays(now, 3)

  // 下个月:初(1-10)/中旬(11-20)/下旬(21-月末)
  const nm = new Date(year, now.getMonth() + 1, 1)
  const nmYear = nm.getFullYear()
  const nmMonth = nm.getMonth()
  const nmLastDay = new Date(nmYear, nmMonth + 1, 0).getDate()
  const mm = String(nmMonth + 1).padStart(2, '0')

  // 下个季度初
  const nextQuarterMonth0 = Math.floor(now.getMonth() / 3) * 3 + 3
  const nq = new Date(nextQuarterMonth0 >= 12 ? year + 1 : year, nextQuarterMonth0 % 12, 1)

  const festivals: string[] = [
    `国庆 ${nextOccurrence(today, year, '10-01')}`,
    `元旦 ${nextOccurrence(today, year, '01-01')}`,
  ]
  const spring = Object.values(SPRING_FESTIVAL).filter(d => d >= today).sort()[0]
  if (spring) festivals.push(`春节 ${spring}`)

  const card = [
    `今天 ${today} ${weekdayOf(now)}(时区 ${tzLabelOf(now)})`,
    `明天 ${ymd(tomorrow)} ${weekdayOf(tomorrow)}|后天 ${ymd(dayAfter)} ${weekdayOf(dayAfter)}|大后天 ${ymd(inThreeDays)} ${weekdayOf(inThreeDays)}`,
    weekRow('本周', monday),
    weekRow('下周', addDays(monday, 7)),
    weekRow('下下周', addDays(monday, 14)),
    `下个月 ${nmYear}-${mm}:初 ${mm}-01~${mm}-10|中旬 ${mm}-11~${mm}-20|下旬 ${mm}-21~${mm}-${nmLastDay}`,
    `下个季度初:${ymd(nq)} 起`,
    `节日锚点:${festivals.join('|')}(「国庆前」= 该日之前,以此类推)`,
  ].join('\n')

  return { today, todayWeekdayZh: weekdayOf(now), tzLabel: tzLabelOf(now), card }
}

/**
 * Extract the smallest named-year intent needed by the planning guard.
 * Historical bypass is intentionally narrow: a negated warning about past
 * dates is not historical lookup, and multiple eligible years are ambiguous.
 */
export function parsePlanningWindow(text: string, anchor: TimeAnchor): PlanningWindow | null {
  const historical = /(?:回测|复盘|backtest|historical)|(?:历史|过去).{0,8}(?:查询|查|检索|回看|回测|复盘)|(?:查询|查|检索|回看).{0,8}(?:历史|过去)/i.test(text)
  const matches: Array<{ year: number; start: number; end: number }> = []
  for (const m of text.matchAll(/(?<!\d)(\d{4})\s*年/g)) {
    const start = m.index ?? 0
    matches.push({ year: Number(m[1]), start, end: start + m[0].length })
  }
  for (const m of text.matchAll(/\b(?:in|within|by)\s+(\d{4})\b/gi)) {
    const start = m.index ?? 0
    matches.push({ year: Number(m[1]), start, end: start + m[0].length })
  }
  if (matches.some(m => !Number.isInteger(m.year) || m.year < 1_000 || m.year > 9_999)) return null
  if (historical && matches.length !== 1) return null

  const planningCue = /计划|规划|安排|打算|希望|想在|要在|完成|出行|旅行|预订|预定/i
  const eligible = matches.filter(m => {
    const before = text.slice(Math.max(0, m.start - 24), m.start)
    const after = text.slice(m.end, m.end + 24)
    return planningCue.test(before) || /^\s*(?:内|以内|完成|出行|旅行|预订|预定)/i.test(after)
  })
  const selected = eligible.length === 1 ? eligible[0] : (historical && matches.length === 1 ? matches[0] : null)
  if (!selected) return null
  return { referenceDate: anchor.today, requestedYear: selected.year, intent: historical ? 'historical' : 'future' }
}

export function planningWindowBounds(window: PlanningWindow, anchor: TimeAnchor): PlanningWindowBounds | null {
  if (window.intent === 'historical') return null
  const currentYear = Number(anchor.today.slice(0, 4))
  if (window.requestedYear < currentYear) return null
  const year = String(window.requestedYear).padStart(4, '0')
  return {
    start: window.requestedYear === currentYear ? anchor.today : `${year}-01-01`,
    end: `${year}-12-31`,
  }
}

/** 严格 ISO 校验:YYYY-MM-DD 必须落在真实日历(2026-02-30/2026-13-01 一律拒)。
 *  复用 Date 月末自动进位:同年/月/day 还原回同一串 = 真日历;否则越界。
 *  同时拒掉非有限值(NaN/Infinity)与越界月日(1-12/1-31)。
 *  供 parseAbsoluteDate 词表口径 + hotel-date-gate 终消费层 复用。 */
export function isRealIsoDate(y: number, m: number, d: number): boolean {
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) return false
  if (m < 1 || m > 12) return false
  if (d < 1 || d > 31) return false
  const dt = new Date(y, m - 1, d)
  return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d
}

/**
 * 绝对月日表达 → YYYY-MM-DD(年缺省时按锚点年)。只识别**绝对**表达:
 * ISO(2026-08-01)、数字点分(8.1 / 9.10)、中文(8月5日 / 8月5号)。
 * 严格校验真日历存在性:2026-02-30 / 2026-13-01 / 2025-02-29 等一律返回 null——
 * 词表外不一致日期不冒充合法,闸会归 unresolved 拒绝发供应商查询(issue #283 红线)。
 * 相对/模糊表达(下周一/明天/本周三/下个月中旬/近期/Aug-5 英文月名)一律返回 null——
 * 逐字保留给下游,本层不做换算也不做过期判定(与评测 golden 对齐:英文月日不判过期)。
 */
export function parseAbsoluteDate(expr: string, anchorYear: number): string | null {
  const t = expr.trim()
  let m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/)
  if (m) {
    const y = Number(m[1]); const mo = Number(m[2]); const d = Number(m[3])
    if (!isRealIsoDate(y, mo, d)) return null
    return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`
  }
  m = t.match(/^(\d{1,2})[./](\d{1,2})(?:日|号)?$/)
  if (m) {
    const mo = Number(m[1]); const d = Number(m[2])
    if (!isRealIsoDate(anchorYear, mo, d)) return null
    return `${anchorYear}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`
  }
  m = t.match(/^(\d{1,2})月(\d{1,2})[日号]?$/)
  if (m) {
    const mo = Number(m[1]); const d = Number(m[2])
    if (!isRealIsoDate(anchorYear, mo, d)) return null
    return `${anchorYear}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`
  }
  return null
}
