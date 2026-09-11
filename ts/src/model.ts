/**
 * Gotry 可行性引擎领域模型(TS 版,与 py/gotry_feasibility/model.py 逐行对齐)。
 *
 * 双实现纪律:Python 版是**对照实现(oracle)**,TS 版是产品运行时实现;
 * 同一输入两版必须给出相同判定(ts/scripts/diff-test.ts 做差分验证)。
 * 算术(门到门全成本)在此层与求解完全分离,两边各自可测。
 */

export function hhmmToMin(s: string): number {
  const [h, m] = s.split(':')
  return Number(h) * 60 + Number(m)
}

export function minToHhmm(m: number): string {
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`
}

export interface TransferMode {
  mode: string
  minutes: number
  priceCny: number
  /**
   * Per-direction overrides supplied by the ground-transfer capability when a
   * driving route fact successfully resolves for outbound (A→B) and/or return
   * (B→A). `minutesOut` feeds the outbound arrival stay minute;
   * `minutesRet` feeds the return departure-from-stay minute. When absent
   * the solver falls back to the symmetric `minutes` field, preserving
   * byte-for-byte behavior for static and symmetric inputs.
   */
  minutesOut?: number
  minutesRet?: number
}

export interface Service {
  id: string
  depMin: number
  arrMin: number
  priceCny: number
  /**
   * Issue #343 v2 路径填充(可选):service 出发/到达对应的真实 UTC instant(epoch ms)。
   * 同一 service 在 arrMin - depMin ≤ 真实飞行时长 跨日 / DST 切换场景下需要这两个字段
   * 才能算出正确的 (arrUtcMs - depUtcMs) / 60000。v1 数值路径不填,由 evaluateChoice/Segment 走
   * 旧 `(arrMin - depMin) - tzOffsetMin` 公式,字节不变。
   */
  depUtcMs?: number
  arrUtcMs?: number
}

export interface HubAccess {
  hub: string
  toHubMin: number
}

export interface MotivationProfile {
  /** 动机谱系,如 { escape_rest: 0.7, curiosity: 0.3 } */
  weights: Record<string, number>
  /** 起床不早于(当日分钟)——由动机推出的硬约束 */
  wakeFloorMin: number
  minArrivalEnergyPct: number
  baseUsableHours: number
  escapeHoursPerWeight: number
}

export interface Candidate {
  id: string
  name: string
  /** 可选的明确出行日;未提供时保持旧版无日期可行性计算语义 */
  date?: string
  hub: string
  bufferOutMin: number
  bufferRetMin: number
  servicesOut: Service[]
  servicesRet: Service[]
  destTransfers: TransferMode[]
  stayCnyPerNight: number
  localDailyCny: number
  minDaysForPurpose: number
  imageryMatch: number
  bestMonths: number[]
}

export interface TravelRequest {
  note: string
  motivation: MotivationProfile
  windowDays: number
  budgetCny: number
  homeHubAccess: Record<string, HubAccess>
}

export interface Choice {
  outService: Service
  outTransfer: TransferMode
  retService: Service
  retTransfer: TransferMode
  days: number
}

export interface TrueCost {
  moneyCny: number
  wakeMin: number
  arriveStayMin: number
  doorToDoorOutMin: number
  energyArrivalPct: number
  usableHours: number
  usableDay1Hours: number
  usableDay2Hours: number
  departHomeRetMin: number
  arriveHomeRetMin: number
}

export function requiredUsableHours(mot: MotivationProfile): number {
  return mot.baseUsableHours + mot.escapeHoursPerWeight * (mot.weights['escape_rest'] ?? 0)
}

// ---- 精力模型(可校准参数,与 Python 版一致) --------------------------------
export const WAKE_PENALTY_BEFORE_5 = 30
export const WAKE_PENALTY_BEFORE_6 = 25
export const WAKE_PENALTY_BEFORE_630 = 15
export const TRANSFER_PENALTY = 8
export const LATE_ARRIVAL_PENALTY = 10
export const LONG_D2D_PENALTY = 10
export const DAY_END_MIN = 21 * 60
export const DAY2_START_MIN = 9 * 60
export const DAY2_QUALITY = 0.9
export const LATEST_ARRIVE_STAY_MIN = 18 * 60

export function parseMotivation(d: Record<string, unknown>): MotivationProfile {
  const hard = (d['hard'] ?? {}) as Record<string, unknown>
  const rawWeights = (d['weights'] ?? d) as Record<string, unknown>
  const weights: Record<string, number> = {}
  for (const [k, v] of Object.entries(rawWeights)) {
    if (typeof v === 'number') weights[k] = v
  }
  return {
    weights,
    wakeFloorMin: hhmmToMin(String(hard['wake_not_before'] ?? '06:30')),
    minArrivalEnergyPct: Number(hard['min_arrival_energy_pct'] ?? 40),
    baseUsableHours: 4.0,
    escapeHoursPerWeight: 2.0,
  }
}

export function parseRequest(d: Record<string, unknown>): TravelRequest {
  const home = ((d['home'] ?? {}) as Record<string, unknown>)['hubs'] as Record<string, Record<string, unknown>> | undefined ?? {}
  const homeHubAccess: Record<string, HubAccess> = {}
  for (const [hub, acc] of Object.entries(home)) {
    homeHubAccess[hub] = { hub, toHubMin: Number(acc['to_hub_min']) }
  }
  return {
    note: String(d['note'] ?? ''),
    motivation: parseMotivation(d['motivation'] as Record<string, unknown>),
    windowDays: Number(d['window_days']),
    budgetCny: Number(d['budget_cny']),
    homeHubAccess,
  }
}

function parseService(d: Record<string, unknown>): Service {
  return { id: String(d['id']), depMin: hhmmToMin(String(d['dep'])), arrMin: hhmmToMin(String(d['arr'])), priceCny: Number(d['price_cny']) }
}

function parseTransfer(d: Record<string, unknown>): TransferMode {
  return { mode: String(d['mode']), minutes: Number(d['min']), priceCny: Number(d['price_cny']) }
}

export function parseCandidate(d: Record<string, unknown>): Candidate {
  return {
    id: String(d['id']),
    name: String(d['name']),
    date: typeof d['date'] === 'string' ? d['date'] : undefined,
    hub: String(d['hub']),
    bufferOutMin: Number(d['buffer_out_min'] ?? 60),
    bufferRetMin: Number(d['buffer_ret_min'] ?? 60),
    servicesOut: (d['services_out'] as Record<string, unknown>[]).map(parseService),
    servicesRet: (d['services_ret'] as Record<string, unknown>[]).map(parseService),
    destTransfers: (d['dest_transfers'] as Record<string, unknown>[]).map(parseTransfer),
    stayCnyPerNight: Number(d['stay_cny_per_night']),
    localDailyCny: Number(d['local_daily_cny']),
    minDaysForPurpose: Number(d['min_days_for_purpose']),
    imageryMatch: Number(d['imagery_match']),
    bestMonths: ((d['best_months'] as number[]) ?? []).map(Number),
  }
}

/** Issue #343 d2d canonical arithmetic。 */
export class NonpositiveDurationError extends Error {
  /** 'arr_not_after_dep' | 'legacy_negative_offset' */
  readonly kind: 'arr_not_after_dep' | 'legacy_negative_offset'
  readonly code = 'nonpositive_duration'
  constructor(kind: 'arr_not_after_dep' | 'legacy_negative_offset', message: string) {
    super(message)
    this.kind = kind
    this.name = 'NonpositiveDurationError'
  }
}

/**
 * doorToDoorFromMove 所需的最小 move 字段。本模型层不耦合 unified.ts 的 MoveSpecTS(避免循环)。
 * unified.ts evaluateOptionMove 必须用这个 helper,而不是再写一份 (arrUtcMs - depUtcMs)/60000。
 */
export interface D2DMoveView {
  bufferMin: number
  originTransferMin: number
  destTransferMin: number
  /** 仅 v1 路径用;v2 路径无需。 */
  tzOffsetMin?: number
}

export interface DoorToDoorParts {
  /** 真实飞行时长(分);v2 = (arrUtcMs - depUtcMs)/60000,v1 = (arrMin - depMin) - tzOffsetMin */
  trueFlightMin: number
  /** 门到门(分) = buffer + originTransfer + trueFlight + destTransfer */
  doorToDoorMin: number
}

/**
 * 单段门到门时长(分)。v2 路径用真实 UTC instant(跨日 / 反向日界线 / DST 切换正确),
 * 且强制 `arrUtcMs > depUtcMs` — parse 边界也会再做一次防御性 throw。
 * v1 路径用墙上分钟差 - tzOffsetMin(原数值口径,字节不变,即使结果为负也照旧返回)。
 *
 * v2:arrUtcMs 必须严格大于 depUtcMs;否则抛 NonpositiveDurationError(arr_not_after_dep)。
 * v1:沿用 legacy 公式,字节不变;不抛错。
 *
 * 调用方(unified.ts evaluateOptionMove)只负责拿到 doorToDoorMin 并包装 LegReport。
 */
export function doorToDoorFromMove(svc: Service, mv: D2DMoveView): DoorToDoorParts {
  if (typeof svc.depUtcMs === 'number' && typeof svc.arrUtcMs === 'number') {
    if (svc.arrUtcMs <= svc.depUtcMs) {
      throw new NonpositiveDurationError(
        'arr_not_after_dep',
        `service ${svc.id}: arrUtcMs (${svc.arrUtcMs}) must be strictly greater than depUtcMs (${svc.depUtcMs})`,
      )
    }
    const trueFlightMin = (svc.arrUtcMs - svc.depUtcMs) / 60_000
    const doorToDoorMin = mv.bufferMin + mv.originTransferMin + trueFlightMin + mv.destTransferMin
    return { trueFlightMin, doorToDoorMin }
  }
  // v1 legacy 字节不变:不校验正负,沿用原公式。
  const trueFlightMin = (svc.arrMin - svc.depMin) - (mv.tzOffsetMin ?? 0)
  const doorToDoorMin = mv.bufferMin + mv.originTransferMin + trueFlightMin + mv.destTransferMin
  return { trueFlightMin, doorToDoorMin }
}

export function evaluateChoice(cand: Candidate, req: TravelRequest, ch: Choice): TrueCost {
  /** 门到门全成本核算(与 Python evaluate_choice 完全一致)。 */
  const access = req.homeHubAccess[cand.hub]
  const outTransferMin = typeof ch.outTransfer.minutesOut === 'number'
    ? ch.outTransfer.minutesOut
    : ch.outTransfer.minutes
  const retTransferMin = typeof ch.retTransfer.minutesRet === 'number'
    ? ch.retTransfer.minutesRet
    : ch.retTransfer.minutes
  const wake = ch.outService.depMin - cand.bufferOutMin - access.toHubMin
  const arriveStay = ch.outService.arrMin + outTransferMin
  const d2dOut = arriveStay - wake

  let energy = 100
  if (wake < 5 * 60) energy -= WAKE_PENALTY_BEFORE_5
  else if (wake < 6 * 60) energy -= WAKE_PENALTY_BEFORE_6
  else if (wake < hhmmToMin('06:30')) energy -= WAKE_PENALTY_BEFORE_630
  energy -= 2 * TRANSFER_PENALTY
  if (arriveStay > 21 * 60) energy -= LATE_ARRIVAL_PENALTY
  if (d2dOut > 6 * 60) energy -= LONG_D2D_PENALTY
  energy = Math.max(0, energy)

  const day1Raw = Math.max(0, DAY_END_MIN - arriveStay) / 60
  const day1 = day1Raw * (0.5 + energy / 200)
  const leaveStayRet = ch.retService.depMin - cand.bufferRetMin - retTransferMin
  const day2 = Math.max(0, leaveStayRet - DAY2_START_MIN) / 60 * DAY2_QUALITY
  const midDays = Math.max(0, ch.days - 2)
  const usable = day1 + day2 + midDays * 8.0 * DAY2_QUALITY

  const money =
    ch.outService.priceCny + ch.retService.priceCny
    + ch.outTransfer.priceCny + ch.retTransfer.priceCny
    + cand.stayCnyPerNight * (ch.days - 1)
    + cand.localDailyCny * ch.days

  return {
    moneyCny: money,
    wakeMin: wake,
    arriveStayMin: arriveStay,
    doorToDoorOutMin: d2dOut,
    energyArrivalPct: energy,
    usableHours: usable,
    usableDay1Hours: day1,
    usableDay2Hours: day2,
    departHomeRetMin: leaveStayRet,
    arriveHomeRetMin: ch.retService.arrMin + access.toHubMin,
  }
}

export function trueCostToDict(t: TrueCost): Record<string, unknown> {
  return {
    money_cny: t.moneyCny,
    wake: minToHhmm(t.wakeMin),
    arrive_stay: minToHhmm(t.arriveStayMin),
    door_to_door_out: `${Math.floor(t.doorToDoorOutMin / 60)}h${String(t.doorToDoorOutMin % 60).padStart(2, '0')}m`,
    energy_arrival_pct: t.energyArrivalPct,
    usable_hours: Math.round(t.usableHours * 10) / 10,
    usable_day1_hours: Math.round(t.usableDay1Hours * 10) / 10,
    usable_day2_hours: Math.round(t.usableDay2Hours * 10) / 10,
    leave_stay_return: minToHhmm(t.departHomeRetMin),
    arrive_home_return: minToHhmm(Math.min(1440, t.arriveHomeRetMin)),
  }
}
