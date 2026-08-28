/**
 * 旅行时间线(memory-design M4 层,P1):「去过哪、何时、和谁」的 append-only 事实层。
 *
 * 立场(memory-design §1):确定性事实归代码——日期解析复用 slot-spec(锚点卡词表+绝对),
 * 词表外 unresolved 不猜;每条事件必须带 evidence(用户原话或 wish 确认),溯源 P0。
 * 消费:出发地三级解析(未来行程→时间线→问用户)/「去过不再推」排序通道/
 * 回流率分子(verified_outcome ⟺ timeline 有对应行程)。
 * 多用户前向兼容:append-only + 稳定 trip_id,账本化只换存储面(RFC §6.5)。
 */

import { parseAbsoluteDate, ymd, type TimeAnchor } from './time-anchor.ts'
import { resolveSlotDate } from './slot-spec.ts'

export type TimelineSource = 'user-verbatim' | 'wish-confirmed'

export interface TimelineEvent {
  schema: 'travel_timeline.v1'
  /** 稳定主键:语义派生(目的地|start|source),重放 no-op */
  trip_id: string
  destination: string
  /** YYYY-MM-DD(入库前必须已解析为绝对日期) */
  start: string
  end?: string
  companions?: string[]
  source: TimelineSource
  /** 用户原话或 wish confirm-outcome 指针 */
  evidence: string
  ts: string
}

/** 相对/模糊表达 → 绝对日期(守门:词表外返回 null,调用方必须拒收而非猜) */
export function resolveTimelineDate(expr: string, anchor: TimeAnchor): string | null {
  return resolveSlotDate(expr, anchor).date
}

/** 语义主键:同目的地+同 start+同 source = 同一行程(重放 no-op) */
export function makeTripId(ev: Omit<TimelineEvent, 'schema' | 'trip_id' | 'ts'>): string {
  return `${ev.destination}|${ev.start}|${ev.source}`.replace(/\s+/g, '_')
}

/**
 * 追加守门(纯函数,不改入参):
 *  - destination/evidence 必填,start 必须已是绝对日期(YYYY-MM-DD),否则拒收(null);
 *  - end < start 拒收;
 *  - 同 trip_id 已存在 → no-op(返回 appended:false,幂等);
 *  - 同目的地日期区间重叠(不同 trip_id)→ 拒收(冲突即停,由人裁决)。
 */
export function appendTrip(
  events: TimelineEvent[],
  ev: Omit<TimelineEvent, 'schema' | 'trip_id' | 'ts'>,
): { events: TimelineEvent[]; appended: boolean; tripId?: string; reason?: string } {
  if (!ev.destination?.trim()) return { events, appended: false, reason: 'destination 必填' }
  if (!ev.evidence?.trim()) return { events, appended: false, reason: 'evidence 必填(用户原话或 wish 确认指针)' }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ev.start)) return { events, appended: false, reason: 'start 必须为 YYYY-MM-DD(词表外日期由上游解析,不猜)' }
  if (ev.end && ev.end < ev.start) return { events, appended: false, reason: 'end 早于 start' }
  const tripId = makeTripId(ev)
  if (events.some(e => e.trip_id === tripId)) return { events, appended: false, tripId }
  const overlap = events.find(e => e.destination === ev.destination && !(e.end && e.end < ev.start) && !(ev.end && ev.end < e.start))
  if (overlap) return { events, appended: false, tripId: overlap.trip_id, reason: `与已有行程 ${overlap.trip_id} 日期重叠,冲突即停` }
  const full: TimelineEvent = { schema: 'travel_timeline.v1', trip_id: tripId, ts: new Date().toISOString(), ...ev }
  return { events: [...events, full], appended: true, tripId }
}

/** 只读投影:按 start 倒序的行程摘要(「去过」行/brief 注入用) */
export function projectTimeline(events: TimelineEvent[]): Array<{ tripId: string; destination: string; start: string; end?: string; companions?: string[] }> {
  return [...events]
    .sort((a, b) => (a.start < b.start ? 1 : -1))
    .map(e => ({ tripId: e.trip_id, destination: e.destination, start: e.start, end: e.end, companions: e.companions }))
}

/**
 * 交叉一致(回流率分子的质变):verified_outcome 的 wish 应有对应时间线行程。
 * 返回缺口清单(verified 但无 timeline)——巡检口径,不自动补写(补写需要用户确认日期)。
 */
export function timelineGapsForVerified(
  timeline: TimelineEvent[],
  verifiedWishes: Array<{ wishId: string; destination?: string }>,
): Array<{ wishId: string }> {
  const dests = new Set(timeline.map(t => t.destination))
  return verifiedWishes.filter(w => w.destination && !dests.has(w.destination)).map(w => ({ wishId: w.wishId }))
}

export { ymd }
