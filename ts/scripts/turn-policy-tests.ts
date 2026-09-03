/**
 * Turn routing & policy table tests (ADR-24 v2).
 * 分类器是纯函数(Tier 0,零 LLM 零 IO),表测锁定 v1 规则面;
 * 首条 fixture 是 2026-09-02 失败轨迹的用户原文——canonical 深规划
 * case 必须命中 deep-planning,这是整个重设计的回归锚点。
 */

import assert from 'node:assert/strict'
import {
  classifyTurn,
  extractTurnSignals,
  TURN_POLICIES,
  turnPolicyFor,
} from '../src/turn-policy.ts'

// ---- 分类表(规则面快照) ---------------------------------------------------

// 失败轨迹原文:13 天行程 + 10.3 婚礼 + 请假 + IRW → 必须转后台。
const TRAJECTORY_MESSAGE = '2026年我还有6天IRW额度 ,我准备再请几天假,在国内待个十几天。'
  + '其中10.3要去湖南衡阳参加同学婚礼。其他我没有特别的要求,请根据我的实际情况,偏好,外部环境等因素,给我安排行程'
assert.equal(classifyTurn(TRAJECTORY_MESSAGE), 'deep-planning')

assert.equal(classifyTurn('9.26到10.12在国内玩,中间要参加同学婚礼'), 'deep-planning') // 双绝对日期+约束,跨度16天
assert.equal(classifyTurn('国庆请假带父母去新疆,大概十几天'), 'deep-planning') // 跨度词+双约束
assert.equal(classifyTurn('帮我查一下明天深圳的天气'), 'quick')
assert.equal(classifyTurn('你好'), 'quick')
assert.equal(classifyTurn('帮我看看10.1去杭州的高铁票'), 'sync-planning') // 单日期零约束 → 默认中间档
assert.equal(classifyTurn('3天后出发,帮我查下天气'), 'sync-planning') // 短跨度词 → 不进 quick 也不进 deep
assert.equal(classifyTurn('把这段翻译成英文:会议纪要如下……省略若干字'.repeat(3)), 'sync-planning') // 长但零信号

// ---- 信号提取 ---------------------------------------------------------------

const full = extractTurnSignals('2026-10-03 出发')
assert.deepEqual(full.absoluteDates, [{ year: 2026, month: 10, day: 3 }])

const md = extractTurnSignals('10月3日到衡阳,10.5回深圳')
assert.equal(md.absoluteDates.length, 2)
assert.equal(md.spanDays, 2)
assert.deepEqual(md.absoluteDates[0], { year: null, month: 10, day: 3 })

// 无效月/日过滤;时间(冒号)与版本号外的数字不产日期
assert.equal(extractTurnSignals('13.45 与 22:40 都是数字').absoluteDates.length, 0)

// 跨度词:按强度取先
assert.equal(extractTurnSignals('待十几天').spanDays, 12)
assert.equal(extractTurnSignals('待半个月').spanDays, 15)
assert.equal(extractTurnSignals('待一个月').spanDays, 30)
assert.equal(extractTurnSignals('大概两周').spanDays, 14)
assert.equal(extractTurnSignals('大概一周').spanDays, 7)
assert.equal(extractTurnSignals('还有6天额度').spanDays, 6)
assert.equal(extractTurnSignals('没有跨度').spanDays, null)

// 绝对日期 ≥2 时跨度词不参与
const both = extractTurnSignals('10.1 到 10.9 玩十几天')
assert.equal(both.spanDays, 8)

// 约束词:命中去重、按词表序
assert.deepEqual(extractTurnSignals('婚礼加IRW,还要请假').constraintHits, ['婚礼', 'IRW', '请假'])
assert.deepEqual(extractTurnSignals('没有任何约束词在这里').constraintHits, [])

// user 消息里最常见的误触:quick 判据必须同时满足零日期/零约束/零跨度/短
assert.equal(classifyTurn('10.3 婚礼那天衡阳天气怎么样?穿什么'), 'sync-planning') // 有日期+约束 → 不冒进 quick

// ---- policy 表 ---------------------------------------------------------------

assert.equal(TURN_POLICIES['deep-planning'].exit, 'handoff')
assert.equal(TURN_POLICIES['sync-planning'].exit, 'converge')
assert.equal(TURN_POLICIES['quick'].exit, 'converge')
for (const policy of Object.values(TURN_POLICIES)) {
  assert.ok(policy.hardMs > policy.softMs, 'hard must exceed soft')
  assert.ok(policy.softMs > 0 && policy.hardMs > 0)
}
assert.deepEqual(turnPolicyFor('quick'), TURN_POLICIES['quick'])

console.log('turn policy tests: OK (routing table incl. trajectory verbatim, date/span extraction, policy shape)')
