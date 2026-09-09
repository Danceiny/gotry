/**
 * 酒店日期校验闸(issue #283 实修):`gotry_hotel_search` 在派发供应商 CLI 前
 * 必须先确认「完整、有效且退房晚于入住」——缺/空/单侧/无法解析/倒序/同日,任一命中
 * 即返回可行动的日期确认结果,绝不发供应商命令、不把当前窗口查询当所需日期
 * 结果。有效自然语言日期复用既有 time-anchor/slot 解析(`buildTimeAnchor` /
 * `resolveSlotDate`),不猜日期、不动既有错误与静态包降级语义。
 *
 * 边界(2026-09-09,issue #283 截图实证):
 *   - 入参:用户原话(逐字);既已支持 `2026-09-18`/`下周五`/`8.20`/`下周五+3`
 *     与词表外 unresolved 降级 + `date_notes`(D-10 切片 B 已落);
 *   - 本闸新增:把「unresolved/单侧/倒序」从「降级无日期」改为「input_required
 *     拒绝派发」——这是缺失日期不能冒充默认窗口价的语义缺口。
 *   - 保留:`resolveSlotDate` 的词表边界(锚点卡词表 + 绝对 + +N);既有
 *     `date_notes` slot-resolved 通路(解析成功时回显原话 → 日期)。
 *   - 不改:`gotry_hotel_search` 静态包降级、hbcli 错误降级、`HBCLI_HOTEL_SEARCH`
 *     效应注册表、断路器与重试策略、上下游 typed 参数契约。
 *
 * 顺序决策(失败原因唯一、可行动一致):
 *   missing(字段未传)> type error(非字符串)> blank(空字符串)> unresolved(词表外)> 倒序/同日
 *   - 同侧 缺失 + 另一侧 非空 → 单侧 missing;两端均 缺失/blank → 同时报缺
 *   - reason/missing/raw/message/evidence 五字段在每条失败路径上一致:
 *       reason    ↔ 最小语义根因
 *       missing   ↔ 用户需补齐的字段集合
 *       raw       ↔ 用户原话(逐字;非字符串视为 undefined,与缺失同形但有 type 标注)
 *       message   ↔ 可行动指引(明确告诉模型/用户「下一步该问什么、给什么形态」)
 *       evidence  ↔ 结构化标签,供落账与调试
 *
 * 验收范围由 issue #283 描述明确划定;此模块不触 dsh/planner/incident
 * observer/其它工具面。
 */
import { buildTimeAnchor } from './time-anchor.ts'
import { resolveSlotDate, type SlotDateResolution } from './slot-spec.ts'

/** 日期闸决策(可序列化;工具层 payload 直接走 JSON) */
export type HotelDateGateReason =
  | 'check_in_missing'
  | 'check_out_missing'
  | 'check_in_blank'
  | 'check_out_blank'
  | 'check_in_unresolved'
  | 'check_out_unresolved'
  | 'check_out_not_after_check_in'

/** 闸失败 = 工具层直接返回,不派发供应商 CLI */
export interface HotelDateGateFailure {
  ok: false
  verdict: 'input_required'
  reason: HotelDateGateReason
  /** 哪些日期字段需要用户补齐(可行动指引的可见面) */
  missing: Array<'checkIn' | 'checkOut'>
  /** 字段名 → 用户原话(逐字;非字符串视为 undefined,与缺失同形) */
  raw: { checkIn?: string; checkOut?: string }
  /** 工具层 evidence + summary 双用的口径统一字符串 */
  message: string
  /** 落账证据链(同其它工具面口径) */
  evidence: string
}

/** 闸通过 = 解析后的绝对日期 + 逐字原话(供 slot-resolved note) */
export interface HotelDateGateSuccess {
  ok: true
  checkIn: string
  checkOut: string
  /** 解析成功的 slot-resolved 注记(原话 → 绝对日期);两侧都无原话变换则空数组 */
  notes: string[]
}

/** 不传 anchor 时按系统时钟建;测试可注入固定 anchor(确定性) */
export interface HotelDateGateOptions {
  now?: Date
}

/**
 * 闸主入口。返回 `HotelDateGateSuccess` 表示闸通过,解析后的绝对日期可直接进入
 * 供应商查询;返回 `HotelDateGateFailure` 表示闸失败,工具层应原样回传 input_required,
 * 不调 `interpretEffect`、不写延迟日志。
 */
export function evaluateHotelStayDates(
  rawCheckIn: unknown,
  rawCheckOut: unknown,
  opts: HotelDateGateOptions = {},
): HotelDateGateSuccess | HotelDateGateFailure {
  const anchor = buildTimeAnchor(opts.now ?? new Date())

  // 形态归一:trim 后字符串(非字符串 → '');raw 保留用户原话(非字符串 → undefined)
  const checkInStr = typeof rawCheckIn === 'string' ? rawCheckIn.trim() : ''
  const checkOutStr = typeof rawCheckOut === 'string' ? rawCheckOut.trim() : ''
  const raw = {
    checkIn: typeof rawCheckIn === 'string' ? rawCheckIn : undefined,
    checkOut: typeof rawCheckOut === 'string' ? rawCheckOut : undefined,
  }
  // 提供性/形态/空白 三态判定(顺序与 reason 映射一致)
  const checkInProvided = rawCheckIn !== undefined
  const checkOutProvided = rawCheckOut !== undefined
  const checkInIsString = typeof rawCheckIn === 'string'
  const checkOutIsString = typeof rawCheckOut === 'string'
  const checkInBlank = checkInIsString && checkInStr === ''
  const checkOutBlank = checkOutIsString && checkOutStr === ''
  const checkInTypeError = checkInProvided && !checkInIsString
  const checkOutTypeError = checkOutProvided && !checkOutIsString

  // 1) 两端均缺失 → 同时报缺(一次追问 UX 更干净)
  if (!checkInProvided && !checkOutProvided) {
    return fail(
      'check_in_missing', ['checkIn', 'checkOut'],
      '请告诉 gotry 入住日(checkIn)和退房日(checkOut);完整、有效且退房晚于入住才能派发供应商查询,缺一不查',
      '[hotel-date-gate@input_required:check_in_missing:both]',
      raw,
    )
  }
  // 2) 单侧缺失(另一侧非空) → 报缺的一侧
  if (!checkInProvided) {
    return fail(
      'check_in_missing', ['checkIn'],
      '请告诉 gotry 入住日(checkIn);退房日已收到,但单侧无法判定窗口,缺入住日不查',
      '[hotel-date-gate@input_required:check_in_missing]',
      raw,
    )
  }
  if (!checkOutProvided) {
    return fail(
      'check_out_missing', ['checkOut'],
      '请告诉 gotry 退房日(checkOut);入住日已收到,但单侧无法判定窗口,缺退房日不查',
      '[hotel-date-gate@input_required:check_out_missing]',
      raw,
    )
  }
  // 3) 类型错误(字段已传但不是字符串) → 按 blank 同形 + 标注类型,提示用户形态
  if (checkInTypeError) {
    return fail(
      'check_in_blank', ['checkIn'],
      `入住日类型错误(收到 ${describeType(rawCheckIn)},期望 string)——请向用户确认具体日期字符串,不要传数字/对象/数组`,
      '[hotel-date-gate@input_required:check_in_blank:type]',
      raw,
    )
  }
  if (checkOutTypeError) {
    return fail(
      'check_out_blank', ['checkOut'],
      `退房日类型错误(收到 ${describeType(rawCheckOut)},期望 string)——请向用户确认具体日期字符串,不要传数字/对象/数组`,
      '[hotel-date-gate@input_required:check_out_blank:type]',
      raw,
    )
  }
  // 4) 两端均空白 → 同时报缺(用户传了字段但全是空串,语义同缺失但 path 不同)
  if (checkInBlank && checkOutBlank) {
    return fail(
      'check_in_blank', ['checkIn', 'checkOut'],
      '入住日与退房日均为空字符串——请向用户确认具体日期,不要传空,不要猜日期',
      '[hotel-date-gate@input_required:check_in_blank:both]',
      raw,
    )
  }
  // 5) 单侧空白
  if (checkInBlank) {
    return fail(
      'check_in_blank', ['checkIn'],
      '入住日为空字符串——请向用户确认具体日期,不要传空,不要猜日期',
      '[hotel-date-gate@input_required:check_in_blank]',
      raw,
    )
  }
  if (checkOutBlank) {
    return fail(
      'check_out_blank', ['checkOut'],
      '退房日为空字符串——请向用户确认具体日期,不要传空,不要猜日期',
      '[hotel-date-gate@input_required:check_out_blank]',
      raw,
    )
  }
  // 6) 解析(复用既有 slot-spec 词表:绝对 / +N / 锚点卡词表;词表外 unresolved)
  const inRes = resolveSlotDate(checkInStr, anchor)
  const outRes = resolveSlotDate(checkOutStr, anchor)
  if (inRes.kind === 'unresolved' || !inRes.date) {
    return fail(
      'check_in_unresolved', ['checkIn'],
      `入住日「${inRes.raw}」无法解析——只支持 ISO(2026-09-18)/点分(8.20)/锚点卡词表(下周五/明天/下个月中旬/+N 后缀);请向用户追问具体日期`,
      '[hotel-date-gate@input_required:check_in_unresolved]',
      raw,
    )
  }
  if (outRes.kind === 'unresolved' || !outRes.date) {
    return fail(
      'check_out_unresolved', ['checkOut'],
      `退房日「${outRes.raw}」无法解析——只支持 ISO(2026-09-18)/点分(8.20)/锚点卡词表(下周五/明天/下个月中旬/+N 后缀);请向用户追问具体日期`,
      '[hotel-date-gate@input_required:check_out_unresolved]',
      raw,
    )
  }
  // 7) 退房必须晚于入住(同日视为 0 晚,价格面无意义;issue #283 红线)
  // 同 reason 不同 evidence 子标签区分两种语义形态(模型可在 routing 里精准分类)
  if (outRes.date <= inRes.date) {
    const sameDay = outRes.date === inRes.date
    return fail(
      'check_out_not_after_check_in', ['checkOut'],
      sameDay
        ? `退房日(${outRes.date})与入住日(${inRes.date})相同——0 晚不查,确认入住天数后重发`
        : `退房日(${outRes.date})早于入住日(${inRes.date})——倒序不查,确认用户意图后重发`,
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

function describeType(v: unknown): string {
  if (v === null) return 'null'
  if (Array.isArray(v)) return 'array'
  return typeof v
}

/**
 * 仅供工具层决定走完整日期解析 vs 复用既有「日期未解析 → 无日期降级」分支时
 * 调用;本闸之外的场景(解析后字符串复用 / 日志等)不应走这个入口。返回值的
 * `date` 为 null 时表示词表外(同 resolveSlotDate.kind=unresolved)。
 */
export function resolveStayDateForProbe(rawExpr: string, now: Date = new Date()): SlotDateResolution {
  return resolveSlotDate(rawExpr, buildTimeAnchor(now))
}