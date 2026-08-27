/**
 * T1 记忆捕获测试(纯函数,零状态,离线确定性):
 *  1. extractFacts: 预算/窗口/出发地/同伴各形态命中
 *  2. 保守性: 无事实消息零捕获;单轮上限 5 条
 *  3. mergeProfile: evidence 追加去重不删历史/hard 覆盖/空事实返 null
 */

import assert from 'node:assert/strict'
import { extractFacts, mergeProfile } from '../src/memory-capture.ts'

// 1) 命中形态
{
  const facts = extractFacts('下个月带爸妈从深圳去大理玩 5 天,预算 5000 元以内')
  const kinds = new Set(facts.map(f => f.kind))
  assert.ok(kinds.has('budget'), `应命中预算,实际 ${JSON.stringify(facts)}`)
  assert.ok(kinds.has('companion'), '应命中同伴(爸妈)')
  assert.ok(kinds.has('origin'), '应命中出发地(深圳)')
  console.log(`1. extractFacts 命中 ${facts.length} 条(${[...kinds].join('/')}) OK`)
}

// 2) 保守性
{
  assert.equal(extractFacts('你好').length, 0, '寒暄零捕获')
  const flood = extractFacts('预算100元 预算200元 预算300元 预算400元 预算500元 预算600元')
  assert.ok(flood.length <= 5, `单轮上限 5,实际 ${flood.length}`)
  console.log('2. 保守性:寒暄零捕获+单轮上限 OK')
}

// 3) mergeProfile
{
  const cur = { weights: { escape_rest: 0.8 }, evidence: ['用户原话:「想去湖边」'] }
  const merged = mergeProfile(cur as never, [
    { kind: 'budget', value: '5000', evidence: '用户原话:「预算 5000 元以内」' },
    { kind: 'origin', value: '深圳', evidence: '用户原话:「从深圳出发」' },
  ] as never)
  assert.ok((merged?.evidence ?? []).some(e => e.includes('湖边')), '既有 evidence 不删(P0)')
  assert.equal(merged?.evidence.length, 3, '新 evidence 追加')
  assert.equal((merged?.hard as Record<string, unknown>)?.budget_cny, 5000)
  assert.equal((merged?.hard as Record<string, unknown>)?.origin, '深圳')
  assert.equal(mergeProfile(cur as never, []), null, '空事实返 null')
  // 幂等:同一 evidence 不重复
  const again = mergeProfile(merged as never, [{ kind: 'budget', value: '5000', evidence: '用户原话:「预算 5000 元以内」' }] as never)
  assert.equal(again?.evidence.length, 3, '同 evidence 不重复追加')
  console.log('3. mergeProfile 追加不删史+hard 覆盖+幂等+空守卫 OK')
}

console.log('\nMEMORY-CAPTURE TESTS: 3/3 OK(T1 纯函数层)')
