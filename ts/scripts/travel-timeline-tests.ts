/**
 * 旅行时间线单测(memory-design P1,travel_timeline.v1):
 * 守门(必填/绝对日期/幂等/重叠冲突即停)/投影/交叉一致(verified 无 timeline 缺口)。
 * 运行:cd ts && npx tsx scripts/travel-timeline-tests.ts
 */

import assert from 'node:assert/strict'
import { appendTrip, makeTripId, projectTimeline, timelineGapsForVerified, resolveTimelineDate, type TimelineEvent } from '../src/travel-timeline.ts'
import { buildTimeAnchor } from '../src/time-anchor.ts'

const anchor = buildTimeAnchor(new Date(2026, 7, 28, 12)) // 2026-08-28
let n = 0
function pass(name: string, body: () => void) {
  body()
  console.log(`  ${++n}. ${name} OK`)
}

pass('守门:必填与绝对日期(不猜)', () => {
  const ev = { destination: '大理', start: '2025-10-01', source: 'user-verbatim' as const, evidence: '用户原话' }
  assert.equal(appendTrip([], { ...ev, destination: '' }).appended, false, '无目的地拒')
  assert.equal(appendTrip([], { ...ev, evidence: '' }).appended, false, '无 evidence 拒(溯源 P0)')
  assert.ok(appendTrip([], { ...ev, start: '下周一' }).reason?.includes('YYYY-MM-DD'), '词表外日期拒收(不猜)')
  assert.ok(appendTrip([], { ...ev, end: '2025-09-30' }).reason?.includes('end 早于 start'), 'end<start 拒')
})

pass('幂等:同目的地+start+source = 同一行程 no-op', () => {
  const ev = { destination: '大理', start: '2025-10-01', source: 'user-verbatim' as const, evidence: '原话' }
  const r1 = appendTrip([], ev)
  assert.equal(r1.appended, true)
  const r2 = appendTrip(r1.events, { ...ev, evidence: '换个说法再说一遍' })
  assert.equal(r2.appended, false, '同 trip_id 重放 no-op')
  assert.equal(r2.tripId, r1.tripId)
})

pass('重叠冲突即停:同目的地日期区间重叠拒收', () => {
  const r1 = appendTrip([], { destination: '大理', start: '2025-10-01', end: '2025-10-05', source: 'user-verbatim', evidence: '原话' })
  const r2 = appendTrip(r1.events, { destination: '大理', start: '2025-10-04', source: 'user-verbatim', evidence: '原话2' })
  assert.equal(r2.appended, false)
  assert.ok(r2.reason?.includes('重叠'), '冲突理由说明')
})

pass('日期解析:锚点卡词表进、词表外 null(经 resolveTimelineDate)', () => {
  assert.equal(resolveTimelineDate('2025-10-01', anchor), '2025-10-01')
  assert.equal(resolveTimelineDate('去年国庆', anchor), null, '开放表达不猜')
})

pass('投影:start 倒序(最近在前)', () => {
  let evs: TimelineEvent[] = []
  evs = appendTrip(evs, { destination: '普吉', start: '2026-07-10', source: 'user-verbatim', evidence: 'a' }).events
  evs = appendTrip(evs, { destination: '大理', start: '2025-10-01', source: 'user-verbatim', evidence: 'b' }).events
  const p = projectTimeline(evs)
  assert.equal(p[0]?.destination, '普吉')
  assert.equal(p.length, 2)
})

pass('交叉一致:verified wish 无 timeline = 缺口暴露(巡检口径,不自动补写)', () => {
  const evs = appendTrip([], { destination: '大理', start: '2025-10-01', source: 'wish-confirmed', evidence: 'wish w1 confirm' }).events
  const gaps = timelineGapsForVerified(evs, [
    { wishId: 'w1', destination: '大理' },
    { wishId: 'w2', destination: '清迈' },
  ])
  assert.deepEqual(gaps, [{ wishId: 'w2' }])
})

pass('trip_id 语义派生:确定性可重放', () => {
  assert.equal(makeTripId({ destination: '大 理', start: '2025-10-01', source: 'user-verbatim', evidence: 'x' }),
    '大_理|2025-10-01|user-verbatim')
})

console.log(`\nTRAVEL TIMELINE TESTS: ${n}/7 OK(memory-design P1 守门面)`)
