/**
 * 同行人档案(memory-design M5 层,P2):同行人及其约束(行动/健康/偏好)的持久化。
 *
 * 立场(memory-design §1):
 *  - 溯源 P0:每条约束伴 evidence(用户原话),追加不删史;
 *  - 约束只进排序与行程结构建议,永不进硬过滤;
 *  - **负面清单守卫**:证件号/电话/地址等敏感字段拒收入库(需要时后端从登录态
 *    填充,fail-closed)——health 存的是「高血压/晕车」这类行为约束,不是病历;
 *  - upsert 合并语义同 mergeProfile:追加不删史/同内容幂等。
 */

export interface CompanionConstraints {
  /** 行动/体力:如「走不了一段」「坐轮椅」 */
  mobility?: string
  /** 健康类行为约束:如「轻度高血压」「晕车」(非病历,禁止诊断性描述) */
  health?: string[]
  /** 偏好:如「怕吵」「爱吃辣」 */
  prefs?: string[]
}

export interface CompanionProfile {
  schema: 'companion_profile.v1'
  /** 稳定主键:label 语义派生(去空白) */
  companion_id: string
  label: string
  constraints: CompanionConstraints
  /** 用户原话,追加不删史 */
  evidence: string[]
  ts: string
}

/** 负面清单:命中即拒收(红线 6 + 隐私立场) */
const SENSITIVE_PATTERNS: Array<{ re: RegExp; label: string }> = [
  { re: /\d{15,17}[Xx]?/, label: '疑似证件号/卡号' },
  { re: /1[3-9]\d{9}/, label: '疑似手机号' },
  { re: /(护照|身份证|证件号|通行证)\s*号?\s*[:：]?\s*\w+/i, label: '证件信息' },
]

/** 守门:内容命中负面清单 → 返回拒收理由;否则 null */
export function sensitiveViolation(text: string): string | null {
  for (const { re, label } of SENSITIVE_PATTERNS) {
    if (re.test(text)) return `负面清单拒收:${label}不入库(需要时由后端从登录态填充)`
  }
  return null
}

/** 稳定主键:label 去空白 */
export function companionId(label: string): string {
  return label.replace(/\s+/g, '')
}

function mergeStrArray(oldArr: string[] | undefined, newArr: string[] | undefined): { merged: string[]; added: boolean } {
  const a = oldArr ?? []
  let added = false
  for (const x of newArr ?? []) {
    if (!a.includes(x)) {
      a.push(x)
      added = true
    }
  }
  return { merged: a, added }
}

/**
 * upsert 合并(纯函数,不改入参):同 companion_id 按 label 归并——
 * constraints 逐字段取新值(新值覆盖旧行为约束,追加数组项),evidence 追加不删史,
 * 全量无新增 → 幂等 no-op(appended:false)。
 */
export function upsertCompanion(
  profiles: CompanionProfile[],
  patch: { label: string; constraints: CompanionConstraints; evidence: string },
): { profiles: CompanionProfile[]; appended: boolean; companionId: string; reason?: string } {
  if (!patch.label?.trim()) return { profiles, appended: false, companionId: '', reason: 'label 必填' }
  const violation = sensitiveViolation(JSON.stringify(patch))
  if (violation) return { profiles, appended: false, companionId: '', reason: violation }
  const id = companionId(patch.label)
  const existing = profiles.find(p => p.companion_id === id)
  if (!existing) {
    const full: CompanionProfile = {
      schema: 'companion_profile.v1',
      companion_id: id,
      label: patch.label.trim(),
      constraints: {
        mobility: patch.constraints.mobility,
        health: patch.constraints.health ? [...patch.constraints.health] : undefined,
        prefs: patch.constraints.prefs ? [...patch.constraints.prefs] : undefined,
      },
      evidence: [patch.evidence],
      ts: new Date().toISOString(),
    }
    return { profiles: [...profiles, full], appended: true, companionId: id }
  }
  const mergedConstraints: CompanionConstraints = {
    mobility: patch.constraints.mobility ?? existing.constraints.mobility,
    health: mergeStrArray(existing.constraints.health, patch.constraints.health).merged,
    prefs: mergeStrArray(existing.constraints.prefs, patch.constraints.prefs).merged,
  }
  const ev = mergeStrArray(existing.evidence, [patch.evidence])
  const healthLen = mergedConstraints.health?.length ?? 0
  const prefsLen = mergedConstraints.prefs?.length ?? 0
  const changed =
    mergedConstraints.mobility !== existing.constraints.mobility ||
    healthLen !== (existing.constraints.health?.length ?? 0) ||
    prefsLen !== (existing.constraints.prefs?.length ?? 0) ||
    ev.added
  if (!changed) return { profiles, appended: false, companionId: id }
  const next = profiles.map(p =>
    p.companion_id === id
      ? { ...p, constraints: mergedConstraints, evidence: ev.merged, ts: new Date().toISOString() }
      : p,
  )
  return { profiles: next, appended: true, companionId: id }
}
