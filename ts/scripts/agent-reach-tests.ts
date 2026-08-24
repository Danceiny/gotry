/**
 * agent-reach web 读取(readUrl 薄壳)测试:
 *  readUrl = URL 校验 + 委托上游 WebChannel.read(反射桥) + Title 提取,自身无网络实现。
 *  上游真读已在 §15 wrapper 测试覆盖;本套只测薄壳行为:
 *  1. 非法 URL(不带 http) → 拒绝,不抛错,降级返回(离线确定性)
 *  2. 1ms 超时 → 桥被杀,降级 error(离线确定性)
 *  3. live 读 example.com → 成功时断言 Title/证据链;网络边界允许降级(不抛错)
 *
 * 运行: cd ts && npx tsx scripts/agent-reach-tests.ts
 */

import assert from 'node:assert/strict'
import { readUrl } from '../capabilities/agent-reach.ts'

// 1. 非法 URL(不带 scheme)
{
  const r = await readUrl({ url: 'example.com' })
  assert.equal(r.ok, false)
  assert.equal(r.via, 'r.jina.ai-error')
  assert.ok(r.evidence.includes('error'), 'evidence 带 error')
  console.log('1. 非法 URL 拒绝 OK')
}

// 2. 超时(1ms 杀掉反射桥进程)
{
  const r = await readUrl({ url: 'https://example.com', timeoutMs: 1 })
  assert.equal(r.ok, false)
  assert.equal(r.via, 'r.jina.ai-error')
  assert.ok(r.latencyMs >= 0, '永不抛错')
  console.log('2. 超时降级 OK')
}

// 3. live 读 example.com(上游 Jina Reader;网络边界允许降级)
{
  const r = await readUrl({ url: 'https://example.com', timeoutMs: 30_000 })
  if (r.ok) {
    assert.ok(r.evidence.includes('[agent-reach:web.read@'), '证据链')
    assert.match(r.evidence, /\[agent-reach:web\.read@2\d{3}-\d{2}-\d{2}T/, '证据链带 ISO 时间戳')
    assert.ok(typeof r.content === 'string' && r.content.length > 0, 'content 非空')
    assert.equal(r.title, 'Example Domain', `Title 提取,实际 ${r.title}`)
    console.log(`3. readUrl example.com → ok (title=${r.title}) OK`)
  } else {
    assert.equal(r.via, 'r.jina.ai-error')
    console.log(`3. readUrl example.com → 降级(${r.error?.slice(0, 60)})(网络边界,合法) OK`)
  }
}

console.log('\nAGENT-REACH TESTS: 3/3 OK(readUrl 薄壳;上游真读见 wrapper 套)')
