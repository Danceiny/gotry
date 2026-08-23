/**
 * agent-reach 能力层测试(r.jina.ai 免费读取,无 key):
 *  1. 真实 URL 读取: example.com 返回 markdown 内容
 *  2. 非法 URL(不带 http): 拒绝,不抛错,降级返回
 *  3. 超时: 用 1ms timeout 触发 abort,返回 error
 *  4. 证据链: 每次调用标 [agent-reach:r.jina.ai@ts]
 *
 * 运行: cd ts && npx tsx scripts/agent-reach-tests.ts
 */

import assert from 'node:assert/strict'
import { readUrl } from '../capabilities/agent-reach.ts'

// 1. 真实 URL 读取(example.com 是稳定公网资源)
{
  const r = await readUrl({ url: 'https://example.com' })
  assert.equal(r.ok, true, `应 ok,实际 error=${r.error}`)
  assert.equal(r.via, 'r.jina.ai')
  assert.ok(r.evidence.includes('agent-reach:r.jina.ai'), '证据链')
  assert.ok(typeof r.content === 'string' && r.content.length > 0, 'content 非空')
  assert.ok(r.latencyMs > 0, 'latency>0')
  console.log(`1. readUrl example.com → ok (${r.content?.slice(0, 80).replace(/\n/g, ' ')}…) OK`)
}

// 2. 非法 URL(不带 scheme)
{
  const r = await readUrl({ url: 'example.com' })
  assert.equal(r.ok, false)
  assert.equal(r.via, 'r.jina.ai-error')
  assert.ok(r.evidence.includes('error'), 'evidence 带 error')
  console.log('2. 非法 URL 拒绝 OK')
}

// 3. 超时
{
  const r = await readUrl({ url: 'https://example.com', timeoutMs: 1 })
  assert.equal(r.ok, false)
  assert.equal(r.via, 'r.jina.ai-error')
  console.log('3. 超时降级 OK')
}

// 4. 证据链包含时间戳
{
  const r = await readUrl({ url: 'https://example.com' })
  assert.match(r.evidence, /agent-reach:r\.jina\.ai@2\d{3}-\d{2}-\d{2}T/, '证据链带 ISO 时间戳')
  console.log('4. 证据链时间戳 OK')
}

console.log('\nAGENT-REACH TESTS: 4/4 OK(r.jina.ai 免费读取)')
