/**
 * T1 动态记忆的合并守门层(M4 记忆域;DeerFlow 研究 T1 落地):
 *
 * 分工(founder 校正「正则匹配 rules 不对」后重写):
 *   - 事实提取 = LLM 的活。契约 (18) 已要求模型当轮把对话透露的新事实
 *     (预算/日期/窗口/出发地/同伴/实际经历)经 gotry_motivation_save 并入
 *     画像(evidence=用户原话)——语言理解交给模型,不做第二套正则引擎。
 *   - 合并守门 = 代码的活。本文件只做三件代码才可靠的事:
 *     ① 追加不删史(evidence 永不移除,P0 反幻觉:历史依据不可篡改)
 *     ② 幂等(同 evidence 不重复入池)
 *     ③ 结构守卫(weights 存在性校验、空补丁拒绝、权重归一)
 *
 * 额外承载(issue #338):用户显式声明的常驻城市/默认出发地——typed
 * homeCity 字段 + 纯函数 resolveDefaultOrigin(explicit origin, profile)。
 *   - 当前轮显式出发地永远赢(explicit origin > home city > missing)
 *   - homeCity 变更必须伴新 evidence(P0 与 weights/hard 同向);单条 evidence
 *     可作为省略 binding 的兼容形态,多条 evidence 必须显式绑定
 *   - 该契约不触碰算术/求解——只读字段,不进 feasibility/evaluate 路径
 *
 * 持久化语义(issue #338):home-city 是 typed self-contained preference
 * 记录 `{ value, evidence, updated_at }`,与全局 evidence 列表解耦——
 * 一次不相关的动机补丁不会改写它的「证据指针」「更新时间」「当前值」。
 * `updated_at` 由调用方在事件边界注入(账本事件行的 ts),mergeProfile
 * 自身不在 fold 路径里再读时钟——保证 rebuildProjections() 与直读投影
 * 永不分叉。
 */

export interface HomeCityPreference {
  /** string=当前默认城市,null=已显式清除(审计一行留痕) */
  value: string | null
  /** 锁定到本次 home-city 操作的用户原话指针(append-only evidence 池里的那条) */
  evidence: string
  /** 账本事件行的 ts(非折叠期再读时钟) */
  updated_at: string
}

export interface ProfilePatch {
  weights?: Record<string, number>
  /** 新增依据(用户原话或工具证据);只增不改不删 */
  evidence?: string[]
  hard?: Record<string, unknown>
  /**
   * 持久化用户常驻城市/默认出发地(issue #338)。
   *   - string = 设置默认城市(用户原话指明常驻)
   *   - null   = 显式清除(审计一行留痕,用于遗忘/迁居)
   *   - undefined = 字段未传,保持当前值不动
   * 改值须伴至少一条新 evidence(同 weights/hard 的 P0 守卫);恰好一条非空
   * evidence 时可省略 homeCityEvidence,多条 evidence 必须显式绑定。
   * 进入合并前会 trim;trim 后空白 → 视为「未传」,不触发变更、不落事件。
   */
  homeCity?: string | null
  /**
   * homeCity 在本次 profile.evidence 中的 exact 用户原话绑定。
   * 显式传入时必须非空、逐字出现在 evidence 且相对当前画像为新值;
   * 未传时仅允许 evidence 恰好一条且非空,由该条提供 unambiguous binding;
   * 唯一例外是同 value/clear state + 同 typed evidence 的重复调用(幂等)。
   */
  homeCityEvidence?: string
}

export interface MergedProfile {
  weights: Record<string, number>
  evidence: string[]
  hard: Record<string, unknown>
  /** 当前持久默认城市。undefined 从未保存;null 显式清除;string 当前默认。 */
  homeCity?: string | null
  /**
   * home-city 自含记录(issue #338):value + 锁定证据 + 更新时间三件套,
   * 与全局 evidence 列表解耦。缺少或不满足完整 typed contract 的画像按
   * missing 处理;raw homeCity 不会成为默认值或证据来源。
   */
  homeCityPreference?: HomeCityPreference
}

const ISO_LIKE_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/

function isNonBlankString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function isValidIsoLikeTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const match = ISO_LIKE_TIMESTAMP.exec(value)
  if (!match) return false
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const hour = Number(match[4])
  const minute = Number(match[5])
  const second = Number(match[6])
  const zone = match[7]!
  const daysInMonth = month === 2
    ? (year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28)
    : [31, 0, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]
  if (!daysInMonth || day < 1 || day > daysInMonth) return false
  // ISO permits 24:00:00 as the end-of-day spelling; no other 24:xx value.
  if (hour > 23 && !(hour === 24 && minute === 0 && second === 0)) return false
  if (minute > 59 || second > 59) return false
  if (zone !== 'Z' && (Number(zone.slice(1, 3)) > 23 || Number(zone.slice(4, 6)) > 59)) return false
  return Number.isFinite(Date.parse(value))
}

/**
 * Typed home-city preference 的唯一有效性判定。
 * 不读取、不修写 raw profile;raw homeCity 若存在只作镜像一致性校验。
 */
export function isValidHomeCityPreference(profile: {
  homeCity?: unknown
  evidence?: unknown
  homeCityPreference?: unknown
} | null): boolean {
  const preference = profile?.homeCityPreference
  if (!preference || typeof preference !== 'object' || Array.isArray(preference)) return false
  const candidate = preference as Partial<HomeCityPreference>
  if (!(candidate.value === null || isNonBlankString(candidate.value))) return false
  if (!isNonBlankString(candidate.evidence) || !isValidIsoLikeTimestamp(candidate.updated_at)) return false
  if (!profile || !Array.isArray(profile.evidence) || !profile.evidence.some(entry => entry === candidate.evidence)) return false
  if (profile && Object.prototype.hasOwnProperty.call(profile, 'homeCity') && profile.homeCity !== candidate.value) return false
  return true
}

/**
 * 合并守门。纯函数;不读时钟——`now` 由调用方从事件边界(appendMotivationPatch
 * 写时 ISO 或 foldEvent 重放时 row.ts)注入,保证写路径与重建路径时间戳一致。
 *
 * 触发 homeCity 操作的同时,会原地维护 typed homeCityPreference:
 *   - valid new binding → 新 `{value, evidence: <homeCityEvidence exact string>, updated_at: now}`
 *   - unchanged → 沿用 base 的 homeCityPreference(若有);缺失 typed 字段保持缺失
 *   - missing/mismatched/stale binding → 返回 null,由账本跳过整次事件
 */
export function mergeProfile(
  current: {
    weights?: Record<string, number>
    evidence?: string[]
    hard?: Record<string, unknown>
    homeCity?: string | null
    homeCityPreference?: HomeCityPreference
  } | null,
  patch: ProfilePatch | null,
  now: string,
): MergedProfile | null {
  if (!patch) return null
  const base = {
    weights: (current?.weights ?? {}) as Record<string, number>,
    evidence: (current?.evidence ?? []) as string[],
    hard: (current?.hard ?? {}) as Record<string, unknown>,
    homeCity: (current?.homeCity === undefined ? undefined : current.homeCity) as string | null | undefined,
    homeCityPreference: current?.homeCityPreference as HomeCityPreference | undefined,
  } // 首次保存:无档案即空档案
  const newEvidence = (patch.evidence ?? []).filter(Boolean).filter(e => !base.evidence.includes(e))
  const patchWeights = patch.weights
  const weightsChanged = !!patchWeights && Object.keys(patchWeights).length > 0 &&
    JSON.stringify(patchWeights) !== JSON.stringify(base.weights)
  const hardChanged = !!patch.hard && Object.keys(patch.hard).length > 0 &&
    JSON.stringify(patch.hard) !== JSON.stringify(base.hard)
  // homeCity 变更判定:
  //   patch.homeCity === undefined → 字段未传,不视为变更
  //   string 先 trim;trim 后空白 → 视作「未传」(避免把空白值当清除语义或无意义值写入)
  //   trim 后与 base.homeCity 仍不等 → 视为变更(包括 string↔null、null↔undefined 等差异)
  let patchedHomeCityInput: string | null | undefined = patch.homeCity
  if (typeof patchedHomeCityInput === 'string') {
    const trimmed = patchedHomeCityInput.trim()
    patchedHomeCityInput = trimmed.length === 0 ? undefined : trimmed
  }
  const homeCityTouched = patchedHomeCityInput !== undefined
  const homeCityChanged = homeCityTouched && patchedHomeCityInput !== base.homeCity

  if (!homeCityTouched && patch.homeCityEvidence !== undefined) return null

  // homeCity 的语义绑定必须在 profile patch 边界明确给出,不从自然语言或
  // evidence 数组位置推断。唯一兼容例外:本次只有一条非空 evidence 时,
  // 该条本身就是 unambiguous binding;多条 evidence 仍必须显式命名。
  let homeCityEvidence: string | undefined
  let homeCityEvidenceIsNew = false
  if (homeCityTouched) {
    const evidenceEntries = patch.evidence ?? []
    const candidate = patch.homeCityEvidence !== undefined
      ? patch.homeCityEvidence
      : evidenceEntries.length === 1 && isNonBlankString(evidenceEntries[0])
        ? evidenceEntries[0]
        : undefined
    const appearsInCall = isNonBlankString(candidate) && evidenceEntries.some(e => e === candidate)
    homeCityEvidenceIsNew = appearsInCall && !base.evidence.includes(candidate)
    const exactDuplicate = appearsInCall && !homeCityEvidenceIsNew && !homeCityChanged
      && base.homeCityPreference?.value === patchedHomeCityInput
      && base.homeCityPreference?.evidence === candidate
    if (!appearsInCall || (!homeCityEvidenceIsNew && !exactDuplicate)) return null
    homeCityEvidence = candidate
  }

  // A same-city/clear operation with a new bound quote is a real preference
  // update even though the value itself did not change. The exact duplicate
  // above remains a no-op.
  const homeCityPreferenceChanged = homeCityTouched && homeCityEvidenceIsNew
  if (newEvidence.length === 0 && !weightsChanged && !hardChanged && !homeCityChanged && !homeCityPreferenceChanged) return null

  // 权重变更必须伴至少一条新 evidence(P0:改画像要有依据),否则拒该部分
  let weights = { ...base.weights }
  if (weightsChanged && newEvidence.length > 0 && patchWeights) {
    weights = { ...weights, ...patchWeights }
    const sum = Object.values(weights).reduce((a, b) => a + b, 0)
    if (sum > 0) for (const k of Object.keys(weights)) weights[k] = Math.round((weights[k]! / sum) * 100) / 100
  }

  // homeCity 操作只接受上面验证过的 exact homeCityEvidence 绑定;无关 evidence
  // 可以继续追加到全局池,但绝不会成为 homeCityPreference 的语义指针。
  let homeCity: string | null | undefined = base.homeCity
  let homeCityPreference: HomeCityPreference | undefined = base.homeCityPreference
  if (homeCityPreferenceChanged) {
    homeCity = patchedHomeCityInput ?? null
    if (homeCityEvidence !== undefined) {
      homeCityPreference = { value: homeCity, evidence: homeCityEvidence, updated_at: now }
    }
  }

  return {
    weights,
    evidence: [...base.evidence, ...newEvidence],
    hard: hardChanged ? { ...base.hard, ...(patch.hard ?? {}) } : { ...base.hard },
    homeCity,
    homeCityPreference,
  }
}

/**
 * 默认出发地解析契约(issue #338)。
 *
 * 纯函数,不读文件、不查 IP/浏览器位置/语言/时区/历史行程;不构造新 evaluate/solve 路径。
 * 调用方负责传入当轮上下文(currentTripOrigin)与持久画像(profile)。
 *
 * 三态判决:
 *   - explicit    当轮显式出发地(用户当轮输入);永远赢,不被持久默认覆盖
 *   - home_default 持久化 homeCity;仅在当轮未指定时填补缺省(用于软排序/兜底)
 *   - missing     二者皆空或显式已清除;调用方须向用户澄清而非自行猜测
 *
 * 该契约的硬约束:
 *   - 不删除候选、不改变可行性判定、不进 evaluate/solve 路径
 *   - 「只进软排序/补缺」语义由调用方在排序/回退层使用本结果
 *
 * 证据来源:只接受 self-contained typed preference(issue #338)的完整合同。
 * 缺字段、镜像不一致或字段 malformed 的画像一律 missing,不从 raw homeCity
 * 或全局 evidence 推断默认值/原话。
 */
export interface DefaultOriginResolution {
  /** 解析后的出发地;null = 调用方应澄清 */
  origin: string | null
  /** 取值来源 */
  source: 'explicit' | 'home_default' | 'missing'
  /** 当前持久 homeCity(原值,便于 UI/日志/审计展示) */
  homeCity: string | null | undefined
  /** 锁定到本次 home-city 操作的用户原话指针;仅 valid home_default 填 */
  homeCityEvidence?: string[]
  /** 是否来自完整 typed preference 路径(便于 audit/UI 区分) */
  homeCityPreferenceSource: 'typed' | 'none'
}

export function resolveDefaultOrigin(
  currentTripOrigin: string | null | undefined,
  profile: {
    homeCity?: string | null
    evidence?: string[]
    homeCityPreference?: HomeCityPreference
  } | null,
): DefaultOriginResolution {
  const trimmed = typeof currentTripOrigin === 'string' ? currentTripOrigin.trim() : ''
  const validTypedPreference = isValidHomeCityPreference(profile)
  const preference = validTypedPreference ? profile?.homeCityPreference as HomeCityPreference : undefined
  const typedValue = preference?.value
  const homeCity = validTypedPreference ? typedValue : undefined
  if (trimmed) {
    return { origin: trimmed, source: 'explicit', homeCity, homeCityPreferenceSource: 'none' }
  }
  if (validTypedPreference && typeof typedValue === 'string') {
    return {
      origin: typedValue.trim(),
      source: 'home_default',
      homeCity,
      homeCityEvidence: [preference!.evidence],
      homeCityPreferenceSource: 'typed',
    }
  }
  return { origin: null, source: 'missing', homeCity, homeCityPreferenceSource: 'none' }
}
