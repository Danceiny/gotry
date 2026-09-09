/**
 * 酒店日期校验闸(issue #283):`gotry_hotel_search` 在派发供应商 CLI 前必须先确认
 * 「完整、有效且退房晚于入住」。缺/空/单侧/类型错/不可解析/倒序/同日/不存在的日历
 * 日期(如 2026-02-30、2026-13-01),任一命中即返回可行动的 input_required,
 * 绝不发供应商命令。有效自然语言日期复用既有 `buildTimeAnchor` /
 * `resolveSlotDate`(已含严格 ISO 校验),不动时间锚点/slot-spec/其它工具。
 *
 * 失败原因(顺序决策,一次问清):
 *   missing(字段未传)> blank(空字符串)> type(非字符串)> unresolved(词表外/不存在的日历)> 倒序/同日
 *   - 同侧 缺失 + 另一侧 空串 → 两端均报缺,两轮往返压成一次
 *   - 五字段契约:reason(最小语义根因)/missing(需补齐的字段)/raw(用户原话)/message(可行动指引)/evidence(落账标签)
 */
import { buildTimeAnchor, isRealIsoDate } from './time-anchor.ts'
import { resolveSlotDate } from './slot-spec.ts'

export type HotelDateGateReason =
  | 'check_in_missing'
  | 'check_out_missing'
  | 'check_in_blank'
  | 'check_out_blank'
  | 'check_in_unresolved'
  | 'check_out_unresolved'
  | 'check_out_not_after_check_in'

export interface HotelDateGateFailure {
  ok: false
  verdict: 'input_required'
  reason: HotelDateGateReason
  /** 需补齐/确认的字段集合(missing/blank 类);unresolved/倒序指明是哪一侧需要更正 */
  missing: Array<'checkIn' | 'checkOut'>
  /** 字段名 → 用户原话(逐字;非字符串视为 undefined) */
  raw: { checkIn?: string; checkOut?: string }
  /** 工具层 evidence + summary 双用的口径统一字符串(用户可行动指引) */
  message: string
  /** 落账证据链(同其它工具面口径) */
  evidence: string
}

export interface HotelDateGateSuccess {
  ok: true
  checkIn: string
  checkOut: string
  /** 解析成功的 slot-resolved 注记(原话 → 绝对日期);两侧都无原话变换则空数组 */
  notes: string[]
}

export interface HotelDateGateOptions {
  now?: Date
}

/**
 * 闸主入口。返回 success 表示闸通过,绝对日期可直接进入供应商查询;
 * 返回 failure 表示闸失败,工具层应原样回传 input_required,不调 interpretEffect、
 * 不写延迟日志。
 */
export function evaluateHotelStayDates(
  rawCheckIn: unknown,
  rawCheckOut: unknown,
  opts: HotelDateGateOptions = {},
): HotelDateGateSuccess | HotelDateGateFailure {
  const anchor = buildTimeAnchor(opts.now ?? new Date())

  const checkInStr = typeof rawCheckIn === 'string' ? rawCheckIn.trim() : ''
  const checkOutStr = typeof rawCheckOut === 'string' ? rawCheckOut.trim() : ''
  const raw = {
    checkIn: typeof rawCheckIn === 'string' ? rawCheckIn : undefined,
    checkOut: typeof rawCheckOut === 'string' ? rawCheckOut : undefined,
  }
  const checkInProvided = rawCheckIn !== undefined
  const checkOutProvided = rawCheckOut !== undefined
  const checkInIsString = typeof rawCheckIn === 'string'
  const checkOutIsString = typeof rawCheckOut === 'string'
  const checkInBlank = checkInIsString && checkInStr === ''
  const checkOutBlank = checkOutIsString && checkOutStr === ''
  const checkInTypeError = checkInProvided && !checkInIsString
  const checkOutTypeError = checkOutProvided && !checkOutIsString

  // 两端均缺失或一侧缺失+另一侧空串 → 一次报齐缺的两侧(避免两轮往返)
  const bothNeedQuery = !checkInProvided && (!checkOutProvided || checkOutBlank)
    || !checkOutProvided && (!checkInProvided || checkInBlank)
  // 两端均空字符串(都已传但都是空串) → 同样报齐
  if (bothNeedQuery || (checkInBlank && checkOutBlank)) {
    const reason = !checkInProvided || checkInBlank ? 'check_in_blank' : 'check_out_blank'
    return fail(
      reason,
      ['checkIn', 'checkOut'],
      '请告诉 gotry 入住日和退房日(具体日期,例如 2026-09-18);完整、有效且退房晚于入住才能查询酒店,缺一不查',
      `[hotel-date-gate@input_required:${reason}:both]`,
      raw,
    )
  }
  // 单侧缺失(另一侧已正常传入) → 报缺的一侧
  if (!checkInProvided) {
    return fail(
      'check_in_missing', ['checkIn'],
      '请告诉 gotry 入住日(具体日期,例如 2026-09-18);退房日已收到,但缺入住日无法判定窗口',
      '[hotel-date-gate@input_required:check_in_missing]',
      raw,
    )
  }
  if (!checkOutProvided) {
    return fail(
      'check_out_missing', ['checkOut'],
      '请告诉 gotry 退房日(具体日期,例如 2026-09-20);入住日已收到,但缺退房日无法判定窗口',
      '[hotel-date-gate@input_required:check_out_missing]',
      raw,
    )
  }
  // 类型错误(字段已传但不是字符串) → 按 blank 同形 + 标注类型,提示用户形态
  if (checkInTypeError) {
    return fail(
      'check_in_blank', ['checkIn'],
      '入住日格式不对(应为日期字符串,例如 2026-09-18)——请向用户确认具体日期',
      '[hotel-date-gate@input_required:check_in_blank:type]',
      raw,
    )
  }
  if (checkOutTypeError) {
    return fail(
      'check_out_blank', ['checkOut'],
      '退房日格式不对(应为日期字符串,例如 2026-09-20)——请向用户确认具体日期',
      '[hotel-date-gate@input_required:check_out_blank:type]',
      raw,
    )
  }
  // 单侧空字符串(另一侧已正常传入)
  if (checkInBlank) {
    return fail(
      'check_in_blank', ['checkIn'],
      '请告诉 gotry 入住日(具体日期,例如 2026-09-18);不要留空,不要猜日期',
      '[hotel-date-gate@input_required:check_in_blank]',
      raw,
    )
  }
  if (checkOutBlank) {
    return fail(
      'check_out_blank', ['checkOut'],
      '请告诉 gotry 退房日(具体日期,例如 2026-09-20);不要留空,不要猜日期',
      '[hotel-date-gate@input_required:check_out_blank]',
      raw,
    )
  }
  // 解析:复用 slot-spec 词表;词表外/不存在的日历日 → unresolved
  const inRes = resolveSlotDate(checkInStr, anchor)
  const outRes = resolveSlotDate(checkOutStr, anchor)
  // 终消费层严格校验(issue #283 红线):resolveSlotDate 的 +N 算术(addDaysYmd) 可能
  // 溢出产生 Invalid Date("NaN-NaN-NaN"),或 JS 自动进位跨千年("10000-01-01")。
  // 词表外/不存在的日历日/算术溢出 一律归 unresolved,不发供应商命令。
  if (inRes.kind === 'unresolved' || !isStrictIsoYmd(inRes.date)) {
    return fail(
      'check_in_unresolved', ['checkIn'],
      `入住日「${inRes.raw}」不是合法的具体日期——请给完整日期(例如 2026-09-18);不接受「近期」「明天之前」这类模糊表达,也不接受 2026-02-30 这类不存在的日历日`,
      '[hotel-date-gate@input_required:check_in_unresolved]',
      raw,
    )
  }
  if (outRes.kind === 'unresolved' || !isStrictIsoYmd(outRes.date)) {
    return fail(
      'check_out_unresolved', ['checkOut'],
      `退房日「${outRes.raw}」不是合法的具体日期——请给完整日期(例如 2026-09-20);不接受「近期」「下周末」这类模糊表达,也不接受 2026-13-01 这类不存在的日历日`,
      '[hotel-date-gate@input_required:check_out_unresolved]',
      raw,
    )
  }
  // 退房必须晚于入住;同日视为 0 晚
  if (outRes.date <= inRes.date) {
    const sameDay = outRes.date === inRes.date
    return fail(
      'check_out_not_after_check_in', ['checkOut'],
      sameDay
        ? `退房日(${outRes.date})与入住日(${inRes.date})相同,0 晚没有意义——请告诉 gotry 退房日应该晚于入住日`
        : `退房日(${outRes.date})早于入住日(${inRes.date}),顺序反了——请告诉 gotry 正确的退房日(应该晚于入住)`,
      sameDay
        ? '[hotel-date-gate@input_required:check_out_not_after_check_in:same_day]'
        : '[hotel-date-gate@input_required:check_out_not_after_check_in:reversed]',
      raw,
    )
  }
  // 通过:绝对日期已就位;slot 解析过程产生的原话 → 绝对日期 注记回显
  const notes: string[] = []
  if (inRes.raw !== inRes.date) notes.push(`slot-resolved: ${inRes.raw} → ${inRes.date}`)
  if (outRes.raw !== outRes.date) notes.push(`slot-resolved: ${outRes.raw} → ${outRes.date}`)
  return { ok: true, checkIn: inRes.date, checkOut: outRes.date, notes }
}

function fail(
  reason: HotelDateGateReason,
  missing: Array<'checkIn' | 'checkOut'>,
  message: string,
  evidence: string,
  raw: { checkIn?: string; checkOut?: string },
): HotelDateGateFailure {
  return { ok: false, verdict: 'input_required', reason, missing, raw, message, evidence }
}

/**
 * 闸终消费层严格校验(issue #283 红线第二层,parseAbsoluteDate 词表口径之外):
 *   1. 必须是字符串且匹配 `YYYY-MM-DD`(4-2-2 数字,前导零),拒 null/NaN/越界格式
 *      (addDaysYmd 溢出产生 "NaN-NaN-NaN",JS 自动进位跨千年产生 "10000-01-01")。
 *   2. 年份 1-9999;复用 `isRealIsoDate` 拒不存在的日历日(2026-02-30 / 2025-02-29 等)。
 * 仅供 evaluateHotelStayDates 在 resolveSlotDate 返回后使用;其它层不要复用此 helper。
 */
function isStrictIsoYmd(s: string | null): s is string {
  if (typeof s !== 'string') return false
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (!m) return false
  const y = Number(m[1]); const mo = Number(m[2]); const d = Number(m[3])
  if (!Number.isFinite(y) || !Number.isFinite(mo) || !Number.isFinite(d)) return false
  if (y < 1 || y > 9999) return false
  return isRealIsoDate(y, mo, d)
}
