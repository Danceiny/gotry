/**
 * 愿望池通道否证测试(外部事件接缝第 2 段,issue #82 兼容方向;全离线纯函数):
 *  1. conditions.channels 命名通道处于 down → 否证成行条件,即使 days/budget/month 全命中
 *  2. 通道全健康(channelDown 空集)→ 不否证不加分,score/hits 与旧口径一致
 *  3. ctx.channelDown 缺席(旧调用方)→ 行为与旧版完全一致(零破坏)
 *  4. 畸形 channels(非数组/非字符串元素)→ 忽略,不误杀
 *  5. pickNudgeWish 集成:最高分愿望被否证 → 次高分顶上(0..1 纪律不变)
 *
 * 运行: cd ts && npx tsx scripts/wish-channel-gate-tests.ts
 */

import assert from 'node:assert/strict'
import { scoreWishMatch, pickNudgeWish, type WishPoolEntry } from '../src/wish-pool.ts'

const base = {
  wish_id: 'w-dubai',
  name: '迪拜',
  added_at: '2026-09-01T00:00:00Z',
  conditions: { days: 5, budget_cny: 8000, best_months: [10, 11], channels: ['hbcli-hotel'] },
}

// ── 1. 命名通道 down → 否证 ─────────────────────────────────────────────────
const vetoed = scoreWishMatch(base as WishPoolEntry, {
  days: 10, budgetCny: 20000, month: 10,
  channelDown: new Set(['hbcli-hotel']),
})
assert.equal(vetoed, null, 'days/budget/month 全命中但依赖通道 down → 否证返回 null')

// ── 2. 通道健康 → 不否证不加分(评分口径不变,/3)────────────────────────────
const healthy = scoreWishMatch(base as WishPoolEntry, {
  days: 10, budgetCny: 20000, month: 10,
  channelDown: new Set<string>(),
})
assert.ok(healthy && healthy.score === 3 && healthy.hits.join('+') === 'days≥5+budget≥8000+month=10', '健康时评分与旧口径一致(score=3)')

// ── 3. channelDown 缺席(旧调用方)→ 零破坏 ──────────────────────────────────
const legacy = scoreWishMatch(base as WishPoolEntry, { days: 10, budgetCny: 20000, month: 10 })
assert.ok(legacy && legacy.score === 3, '不传 channelDown 的旧调用行为不变')

// ── 4. 畸形 channels 忽略 ────────────────────────────────────────────────────
const malformed = scoreWishMatch({
  ...base,
  conditions: { days: 5, channels: 'hbcli-hotel' },
} as WishPoolEntry, { days: 10, month: 10, channelDown: new Set(['hbcli-hotel']) })
assert.ok(malformed && malformed.score === 1, '非数组 channels 被忽略,不误杀')
const mixed = scoreWishMatch({
  ...base,
  conditions: { days: 5, channels: [42, null, 'hbcli-hotel'] },
} as WishPoolEntry, { days: 10, month: 10, channelDown: new Set(['hbcli-hotel']) })
assert.equal(mixed, null, '数组内字符串元素仍参与否证(非字符串忽略)')

// ── 5. pickNudgeWish 集成:最高分被否证 → 次高顶上 ───────────────────────────
const pool: WishPoolEntry[] = [
  { ...base, added_at: '2026-09-01T00:00:00Z' },
  { wish_id: 'w-osaka', name: '大阪', added_at: '2026-09-02T00:00:00Z', conditions: { days: 5, best_months: [10] } },
]
const picked = pickNudgeWish(pool, { days: 10, month: 10, channelDown: new Set(['hbcli-hotel']) })
assert.ok(picked && picked.wishId === 'w-osaka', `被否证的 w-dubai 退出,次高 w-osaka 顶上,实际 ${picked?.wishId}`)
const none = pickNudgeWish([base as WishPoolEntry], { days: 10, month: 10, channelDown: new Set(['hbcli-hotel']) })
assert.equal(none, null, '全部被否证 → null(不硬推纪律保持)')

console.log('WISH CHANNEL GATE TESTS: 5/5 OK(否证 / 健康不加分 / 旧调用零破坏 / 畸形忽略 / 0..1 集成)')
