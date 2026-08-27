/**
 * 时间锚点层(确定性纯函数,零依赖):「今天是哪天、相对日期怎么换算」的算术全部在这里,
 * LLM 只查锚点卡不自算(仓规:算术只在代码层;tool-owned dates 的执行面)。
 *
 * 消费面:
 *  - dsh 成品路径:index.ts 注册 {{time_anchor_card}} 变量,系统时钟;
 *  - legacy 抽取路径:dsh-llm.ts 注入 FACTS/SKELETON/槽位抽取 prompt;
 *  - 评测:time-eval-tests.ts 用固定 now(2026-08-27)保证确定性。
 *
 * 债务(architecture §10 登记):节日锚点表 SPRING_FESTIVAL 硬编码(2026-08-28 扩至 2031);
 * 跨 2031 前必须再扩表,否则春节锚点静默缺失。
 */

export interface TimeAnchor {
  /** 今天 YYYY-MM-DD(宿主机本地时区) */
  today: string
  /** 今天星期几,如「周四」 */
  todayWeekdayZh: string
  /** 时区标注,如 UTC+8 / UTC+5:30 */
  tzLabel: string
  /** 注入 prompt 的多行锚点卡文本 */
  card: string
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

/** 春节锚点表(仅此节日漂移大,硬编码;元旦/国庆固定月日,按「下一次发生」算)。D-9:2026-08-28 扩至 2031 */
const SPRING_FESTIVAL: Record<number, string> = {
  2026: '2026-02-17',
  2027: '2027-02-06',
  2028: '2028-01-26',
  2029: '2029-02-13',
  2030: '2030-02-03',
  2031: '2031-01-23',
}

function tzLabelOf(d: Date): string {
  const offsetMin = -d.getTimezoneOffset()
  const sign = offsetMin >= 0 ? '+' : '-'
  const abs = Math.abs(offsetMin)
  const h = Math.floor(abs / 60)
  const m = abs % 60
  return `UTC${sign}${m === 0 ? h : `${h}:${String(m).padStart(2, '0')}`}`
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
 * 绝对月日表达 → YYYY-MM-DD(年缺省时按锚点年)。只识别**绝对**表达:
 * ISO(2026-08-01)、数字点分(8.1 / 9.10)、中文(8月5日 / 8月5号)。
 * 相对/模糊表达(下周一/明天/本周三/下个月中旬/近期/Aug-5 英文月名)一律返回 null——
 * 逐字保留给下游,本层不做换算也不做过期判定(与评测 golden 对齐:英文月日不判过期)。
 */
export function parseAbsoluteDate(expr: string, anchorYear: number): string | null {
  const t = expr.trim()
  let m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/)
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`
  m = t.match(/^(\d{1,2})[./](\d{1,2})(?:日|号)?$/)
  if (m) return `${anchorYear}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`
  m = t.match(/^(\d{1,2})月(\d{1,2})[日号]?$/)
  if (m) return `${anchorYear}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`
  return null
}
