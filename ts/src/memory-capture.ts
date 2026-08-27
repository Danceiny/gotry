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
 */

export interface ProfilePatch {
  weights?: Record<string, number>
  /** 新增依据(用户原话或工具证据);只增不改不删 */
  evidence?: string[]
  hard?: Record<string, unknown>
}

export interface MergedProfile {
  weights: Record<string, number>
  evidence: string[]
  hard: Record<string, unknown>
}

/** 与现有画像合并;无可并入内容返回 null(调用方跳过落盘)。纯函数。 */
export function mergeProfile(
  current: { weights?: Record<string, number>; evidence?: string[]; hard?: Record<string, unknown> } | null,
  patch: ProfilePatch | null,
): MergedProfile | null {
  if (!patch) return null
  const base = {
    weights: (current?.weights ?? {}) as Record<string, number>,
    evidence: (current?.evidence ?? []) as string[],
    hard: (current?.hard ?? {}) as Record<string, unknown>,
  } // 首次保存:无档案即空档案
  const newEvidence = (patch.evidence ?? []).filter(Boolean).filter(e => !base.evidence.includes(e))
  const patchWeights = patch.weights
  const weightsChanged = !!patchWeights && Object.keys(patchWeights).length > 0 &&
    JSON.stringify(patchWeights) !== JSON.stringify(base.weights)
  const hardChanged = !!patch.hard && Object.keys(patch.hard).length > 0 &&
    JSON.stringify(patch.hard) !== JSON.stringify(base.hard)
  if (newEvidence.length === 0 && !weightsChanged && !hardChanged) return null

  // 权重变更必须伴至少一条新 evidence(P0:改画像要有依据),否则拒该部分
  let weights = { ...base.weights }
  if (weightsChanged && newEvidence.length > 0 && patchWeights) {
    weights = { ...weights, ...patchWeights }
    const sum = Object.values(weights).reduce((a, b) => a + b, 0)
    if (sum > 0) for (const k of Object.keys(weights)) weights[k] = Math.round((weights[k]! / sum) * 100) / 100
  }

  return {
    weights,
    evidence: [...base.evidence, ...newEvidence],
    hard: hardChanged ? { ...base.hard, ...(patch.hard ?? {}) } : { ...base.hard },
  }
}
