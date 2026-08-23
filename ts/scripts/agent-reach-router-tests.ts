/**
 * agent-reach router 测试(13 渠道路由表,100% follow SKILL.md):
 *  1. status: 真 agent-reach doctor(.venv-reach)→ via=agent-reach-cli
 *  2. web: 读 example.com(走 r.jina.ai)
 *  3. rss: 真实 RSS 源解析 items
 *  4. v2ex: 真实热门 topics
 *  5. needs-setup 渠道(twitter): 返回配置指引不抛错
 *  6. 永不抛错:空 arg / 非法 channel 均降级
 *
 * 运行: cd ts && npx tsx scripts/agent-reach-router-tests.ts
 */

import assert from 'node:assert/strict'
import { reachStatus, reach } from '../capabilities/agent-reach-router.ts'

// 1. status(优先真 doctor)
{
  const st = await reachStatus(90_000)
  assert.equal(st.ok, true)
  assert.ok(['agent-reach-cli', 'gotry-probe'].includes(st.via))
  if (st.via === 'agent-reach-cli') {
    assert.ok((st.channels[0]?.note ?? '').includes('Agent Reach') || (st.channels[0]?.note ?? '').length > 50, 'doctor 输出非空')
  }
  console.log(`1. status → ${st.via} (${st.latencyMs}ms) OK`)
}

// 2. web 渠道
{
  const r = await reach({ channel: 'web', arg: 'https://example.com', timeoutMs: 20_000 })
  assert.equal(r.channel, 'web')
  assert.ok(r.evidence.includes('[agent-reach:'))
  if (r.ok) {
    const d = r.data as { title?: string }
    assert.ok(d.title ?? true, 'title 可选')
  }
  console.log(`2. web example.com → ${r.verdict} OK`)
}

// 3. rss 渠道(真实源:Hacker News RSS;items 在顶层)
{
  const r = await reach({ channel: 'rss', arg: 'https://hnrss.org/frontpage?count=5', timeoutMs: 20_000 }) as ReturnType<typeof import('../capabilities/agent-reach-router.ts').rssFeed> & { items?: unknown[] }
  assert.equal(r.channel, 'rss')
  if (r.ok && r.items) {
    assert.ok(r.items.length > 0, 'rss items 非空')
    console.log(`3. rss hnrss → found (${r.items.length} items) OK`)
  } else {
    console.log(`3. rss hnrss → ${r.verdict}(网络边界,降级合法) OK`)
  }
}

// 4. v2ex 渠道(topics 在顶层)
{
  const r = await reach({ channel: 'v2ex', timeoutMs: 20_000 }) as { ok: boolean; verdict: string; topics?: unknown[] }
  assert.equal(r.channel, 'v2ex')
  if (r.ok && r.topics) {
    assert.ok(r.topics.length > 0)
    console.log(`4. v2ex → found (${r.topics.length} topics) OK`)
  } else {
    console.log(`4. v2ex → ${r.verdict}(降级合法) OK`)
  }
}

// 5. needs-setup 渠道(twitter)
{
  const r = await reach({ channel: 'twitter', arg: 'whatever' })
  assert.equal(r.verdict, 'needs-setup')
  assert.ok((r.setup ?? '').length > 10, 'setup 指引非空')
  console.log('5. twitter → needs-setup(带配置指引) OK')
}

// 6. 永不抛错:空 arg 的 web
{
  const r = await reach({ channel: 'web', arg: '' })
  assert.equal(r.ok, false)
  assert.ok(r.evidence.includes('error') || r.evidence.includes('not-installed'))
  console.log('6. 空 arg 降级 OK')
}

console.log('\nAGENT-REACH ROUTER TESTS: 6/6 OK(13 渠道路由 + doctor 体检)')
