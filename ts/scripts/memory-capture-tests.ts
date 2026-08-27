/**
 * T1 合并守门层测试(纯函数,零状态,离线确定性):
 *  1. 追加不删史+幂等:同 evidence 不重复;既有依据永不移除(P0)
 *  2. 权重归一:P0 校验——改 weights 必须伴新 evidence,否则拒该部分
 *  3. 守卫:空补丁/无变化返 null;hard 覆盖后到优先
 */

import assert from 'node:assert/strict'
import { mergeProfile } from '../src/memory-capture.ts'

const cur = {
  weights: { escape_rest: 1 },
  evidence: ['用户原话:「想去湖边什么都不干」'],
  hard: { wake_not_before: '07:00' },
}

// 1) 追加不删史 + 幂等
{
  const m1 = mergeProfile(cur, { evidence: ['用户原话:「预算 5000 以内」', '用户原话:「想去湖边什么都不干」'] } as never)
  assert.equal(m1?.evidence.length, 2, `追加新+跳过重复,实际 ${m1?.evidence.length}`)
  assert.ok(m1?.evidence[0].includes('湖边'), '既有 evidence 原位保留(P0)')
  const m2 = mergeProfile(m1 as never, { evidence: ['用户原话:「预算 5000 以内」'] } as never)
  assert.equal(m2, null, '纯重复补丁应返 null(幂等)')
  console.log('1. 追加不删史 + 幂等 OK')
}

// 2) 权重归一与 P0 校验
{
  const m = mergeProfile(cur, { weights: { escape_rest: 0.5, curiosity: 0.5 }, evidence: ['用户原话:「这次既要躺平也要探索」'] } as never)
  const sum = Object.values(m?.weights ?? {}).reduce((a, b) => a + b, 0)
  assert.ok(Math.abs(sum - 1) < 0.01, `权重应归一,实际 sum=${sum}`)
  const noEv = mergeProfile(cur, { weights: { escape_rest: 0.3, curiosity: 0.7 } } as never)
  assert.equal(noEv?.weights.escape_rest, 1, '权重变更无新 evidence 应被拒(P0)')
  console.log('2. 权重归一 + P0 证据校验 OK')
}

// 2.5) 首次保存:current=null 视为空档案,补丁全量生效
{
  const first = mergeProfile(null, { weights: { escape_rest: 1 }, evidence: ['用户原话:「想去湖边」'] } as never)
  assert.ok(first && first.evidence.length === 1 && Object.keys(first.weights).length === 1, '首存应生效')
  assert.equal(mergeProfile(null, null), null, 'null 补丁仍守卫')
  console.log('2.5 首存语义(current=null→空档案) OK')
}

// 3) 守卫与 hard 覆盖
{
  assert.equal(mergeProfile(cur, null), null, 'null 补丁')
  assert.equal(mergeProfile(cur, {} as never), null, '空补丁')
  const m = mergeProfile(cur, { hard: { wake_not_before: '08:30', budget_cny: 5000 } } as never)
  assert.equal((m?.hard as Record<string, unknown>)?.wake_not_before, '08:30', 'hard 后到优先')
  assert.equal((m?.hard as Record<string, unknown>)?.budget_cny, 5000, 'hard 新键并入')
  console.log('3. 空守卫 + hard 覆盖后到优先 OK')
}

console.log('\nMEMORY-MERGE TESTS: 3/3 OK(T1 合并守门层)')
