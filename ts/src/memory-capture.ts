/**
 * T1 动态记忆捕获(DeerFlow 研究 T1 的 gotry 落地,M4 记忆域第一块):
 *
 * 问题:动机画像只靠 motivation_save 显式调用——对话里透露的新事实
 * (预算/日期/窗口/出发地/同伴/实际经历)轮次结束就丢,#1 重复问的根因。
 *
 * 设计(纯函数,零副作用,smoke 可测;插件层在 runTurn 后调 captureFromTurn):
 *   - extractFacts: 从用户消息+工具结果中抽结构化事实(启发式:已知键值/
 *     数字+单位/地名锚点),保守优先——拿不准的不入池(契约 18:当轮并入,
 *     但 evidence 永远是用户原话或工具证据)
 *   - mergeProfile: 与现有画像合并(weights 归一/新事实追加 evidence/
 *     hard 覆盖),永不删除既有 evidence(P0 反幻觉:历史依据不可篡改)
 *
 * 插件接入(runTurn 尾部,founder 对话即插即用):
 *   const patch = captureFromTurn(userMsg, state)
 *   if (patch) await saveProfilePatch(patch)
 */

export interface CapturedFact {
  kind: 'budget' | 'window' | 'origin' | 'companion' | 'preference' | 'fact'
  value: string
  evidence: string
}

interface Rule {
  kind: CapturedFact['kind']
  re: RegExp
  /** 数字归一(如 ¥3000 → "3000") */
  norm?: (m: RegExpMatchArray) => string
}

const RULES: Rule[] = [
  { kind: 'budget', re: /预算[^\d]{0,6}(\d[\d,.]*\s*万?|[¥￥]\s*\d[\d,]*)\s*(?:元|块|cny)?/i, norm: m => m[1].replace(/[,\s¥￥元块]/g, '') },
  { kind: 'budget', re: /(\d[\d,]*)\s*(?:元|块|cny)\s*(?:以内|以内|以内|以下|预算)/i, norm: m => m[1].replace(/,/g, '') },
  { kind: 'window', re: /([一二三四五六日]|\d{1,2})月\s*\d{1,2}[日号](?:到|至|–|-)\s*(?:(\d{1,2})月)?(\d{1,2})[日号]/ },
  { kind: 'window', re: /(\d{4}-\d{2}-\d{2})\s*(?:到|至|–|-)\s*(\d{4}-\d{2}-\d{2})/ },
  { kind: 'window', re: /(\d+)\s*天(?:的)?(?:窗口|假期|行程)/ },
  { kind: 'origin', re: /(?:从|在)?(深圳|上海|北京|广州|杭州|成都|昆明|香港|迪拜|珠海|西安|武汉|南京|重庆|厦门|青岛|三亚|大理|丽江)(?:出发|[飞走去到])/ },
  { kind: 'companion', re: /和?(爸妈|父母|女朋友|女朋友|老婆|老公|孩子|朋友|同事|一个人|独自|家人)/ },
]

/** 从一条用户消息抽取候选事实(evidence=原文切片;保守,宁缺勿错) */
export function extractFacts(userMsg: string): CapturedFact[] {
  if (!userMsg || userMsg.length < 4) return []
  const facts: CapturedFact[] = []
  for (const rule of RULES) {
    const m = userMsg.match(rule.re)
    if (!m) continue
    const value = rule.norm ? rule.norm(m) : (m[0]?.trim() ?? '')
    if (!value || facts.some(f => f.kind === rule.kind && f.value === value)) continue
    facts.push({ kind: rule.kind, value, evidence: `用户原话:「${userMsg.slice(Math.max(0, (m.index ?? 0) - 10), (m.index ?? 0) + m[0].length + 20).trim()}」` })
  }
  return facts.slice(0, 5) // 单轮上限:防 prompt 注入式灌池
}

/** 与现有画像合并:weights 重归一/evidence 追加去重/hard 覆盖(后到优先) */
export function mergeProfile(
  current: { weights?: Record<string, number>; evidence?: string[]; hard?: Record<string, unknown> } | null,
  facts: CapturedFact[],
): { weights?: Record<string, number>; evidence: string[]; hard?: Record<string, unknown> } | null {
  if (facts.length === 0) return null
  const out: { weights?: Record<string, number>; evidence: string[]; hard?: Record<string, unknown> } = {
    evidence: [...(current?.evidence ?? [])],
    ...(current?.hard ? { hard: { ...current.hard } } : {}),
  }
  for (const f of facts) {
    if (!out.evidence.includes(f.evidence)) out.evidence.push(f.evidence)
    if (f.kind === 'budget') out.hard = { ...out.hard, budget_cny: Number(f.value) || f.value }
    if (f.kind === 'origin') out.hard = { ...out.hard, origin: f.value }
  }
  return out
}
