/**
 * 记忆效用 sidecar(RFC S2,post-outcome-memory-utility-attribution 映射):
 * 「被召回 ≠ 有用,自称用了 ≠ 让结果变好」——召回/使用/结果/归因四件语义独立记录,
 * 确定性 reducer 只做投影;verified_outcome 只能来自 owner 确认(owner_correction tier),
 * 模型永远不能自称「有用」。默认 fail-open:sidecar 缺失/损坏不阻塞主路径。
 *
 * 多用户 AaaS 前向兼容(RFC §6.5):append-only 事件流 + 稳定 wish_id,
 * 未来账本化(CAS/receipt)是存储面替换,语义层零改造。
 */

export type UtilityEventKind = 'recalled' | 'applied' | 'verified_outcome'
/** 归因只能来自 verified_outcome 事件,且必须 owner 确认(用户原话/显式选择) */
export type UtilityAttribution = 'helpful' | 'harmful' | 'neutral'

export interface MemoryUtilityEvent {
  schema: 'memory_utility_observation.v0'
  /** 幂等键:wish_id|kind|ctx|attribution 派生(语义派生,不用墙钟) */
  event_id: string
  wish_id: string
  kind: UtilityEventKind
  ts: string
  /** 召回/确认发生的表面(turn id / 工具调用标识) */
  ctx?: string
  detail?: string
  /** 仅 verified_outcome 携带;owner_correction tier */
  attribution?: UtilityAttribution
}

export type UtilityStatus = 'unknown' | UtilityAttribution

export interface WishUtility {
  wish_id: string
  status: UtilityStatus
  recalled: number
  applied: number
  verified: number
  last_event_ts?: string
}

/** 事件幂等键:同 wish 同类同 ctx 同归因 = 同一事件(重放 no-op) */
export function makeEventId(ev: Omit<MemoryUtilityEvent, 'schema' | 'event_id'>): string {
  return [ev.wish_id, ev.kind, ev.ctx ?? '', ev.attribution ?? ''].join('|')
}

/** 追加不重复(纯函数,不改入参):同 event_id 已存在 → no-op */
export function appendEvent(events: MemoryUtilityEvent[], ev: Omit<MemoryUtilityEvent, 'schema' | 'event_id'>): { events: MemoryUtilityEvent[]; appended: boolean } {
  const full: MemoryUtilityEvent = { schema: 'memory_utility_observation.v0', event_id: makeEventId(ev), ...ev }
  if (events.some(e => e.event_id === full.event_id)) return { events, appended: false }
  if (ev.kind === 'verified_outcome' && !ev.attribution) {
    // 无归因的结果不算归因证据:降级为 applied(六件语义不越界)
    return appendEvent(events, { ...ev, kind: 'applied' })
  }
  return { events: [...events, full], appended: true }
}

/** 只读投影:status = 最后一次 verified_outcome 的归因;无 verified_outcome 永远 unknown */
export function projectUtility(events: MemoryUtilityEvent[]): Record<string, WishUtility> {
  const out: Record<string, WishUtility> = {}
  for (const ev of events) {
    const w = out[ev.wish_id] ??= { wish_id: ev.wish_id, status: 'unknown', recalled: 0, applied: 0, verified: 0 }
    if (ev.kind === 'recalled') w.recalled++
    if (ev.kind === 'applied') w.applied++
    if (ev.kind === 'verified_outcome') {
      w.verified++
      if (ev.attribution) w.status = ev.attribution
    }
    w.last_event_ts = ev.ts
  }
  return out
}
