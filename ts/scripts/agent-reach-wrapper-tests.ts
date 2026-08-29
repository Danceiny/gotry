/**
 * agent-reach wrapper 测试(零渠道知识,全部走反射桥):
 *  1. status: 真 agent-reach doctor 透传(via=agent-reach-cli)
 *  2. web.read: 真读 example.com(上游 Jina Reader 后端)
 *  3. v2ex.get_hot_topics: 上游 python 方法真调(网络边界允许降级)
 *  4. xueqiu.get_stock_quote: 无 cookie → needs-setup 且 setup=上游 check() 原话
 *  5. 未知渠道 → 自描述错误带回上游渠道清单
 *  6. 未知方法 → 自描述错误带回上游方法签名清单
 *  7. 永不抛错: 空 channel/method 降级
 *
 * 运行: cd ts && npx tsx scripts/agent-reach-wrapper-tests.ts
 */

import assert from 'node:assert/strict'
import { reach, reachStatus } from '../capabilities/agent-reach.ts'

// 1. status(真 doctor 原样透传;agent-reach 未装时结构化 SKIP——真集成面设备绑定,
//    与 §17 skills-contract「有凭证真校验,离线 SKIP」同构;CI 装了则全跑 7 断言)
{
  const st = await reachStatus(90_000)
  if (!st.ok) {
    console.log(`SKIP: agent-reach doctor 未就绪(未安装/needs-setup),7 断言整体跳过 — via=${st.via} output=${String(st.output).slice(0, 120)}`)
    process.exit(0)
  }
  assert.equal(st.ok, true)
  assert.equal(st.via, 'agent-reach-cli')
  assert.ok(st.output.length > 50, 'doctor 输出非空(上游原样)')
  console.log(`1. status → doctor 透传 (${st.latencyMs}ms) OK`)
}

// 2. web.read(上游 WebChannel.read → Jina Reader)
{
  const r = await reach({ channel: 'web', method: 'read', args: ['https://example.com'], timeoutMs: 30_000 })
  assert.equal(r.verdict, 'found')
  assert.ok(r.evidence.includes('[agent-reach:web.read@'), '证据链 [agent-reach:web.read@ts]')
  // live 内容会漂移(同 §13),断言非空 markdown 而非精确文案
  assert.ok(typeof r.data === 'string' && r.data.length > 200, 'content 非空 markdown')
  console.log(`2. web.read example.com → found (${r.latencyMs}ms) OK`)
}

// 3. v2ex.get_hot_topics(上游 python 方法;网络边界允许降级不抛错)
{
  const r = await reach({ channel: 'v2ex', method: 'get_hot_topics', timeoutMs: 30_000 })
  if (r.ok) {
    assert.ok(Array.isArray(r.data), 'hot topics 是数组')
    console.log(`3. v2ex.get_hot_topics → found (${(r.data as unknown[]).length} topics) OK`)
  } else {
    assert.ok(['error', 'needs-setup'].includes(r.verdict), '降级合法')
    console.log(`3. v2ex.get_hot_topics → ${r.verdict}(网络边界,降级合法) OK`)
  }
}

// 4. xueqiu.get_stock_quote(无 cookie → needs-setup 且 setup 是上游 check() 原话)
{
  const r = await reach({ channel: 'xueqiu', method: 'get_stock_quote', args: ['SH600519'], timeoutMs: 30_000 })
  assert.equal(r.verdict, 'needs-setup', `实际 verdict=${r.verdict} error=${r.error}`)
  assert.ok((r.setup ?? '').includes('configure'), 'setup 透传上游 configure 指引(不转述)')
  console.log('4. xueqiu.get_stock_quote → needs-setup(上游原话指引) OK')
}

// 5. 未知渠道 → 自描述,带回上游渠道清单
{
  const r = await reach({ channel: 'nosuch', method: 'foo' })
  assert.equal(r.ok, false)
  const channels = (r.inventory?.channels ?? {}) as Record<string, string>
  assert.ok(channels.web && channels.xueqiu && channels['exa_search'], 'inventory 带回上游注册表(含 exa_search 真名)')
  console.log(`5. 未知渠道 → 自描述清单(${Object.keys(channels).length} 渠道) OK`)
}

// 6. 未知方法 → 自描述,带回上游方法签名清单
{
  const r = await reach({ channel: 'web', method: 'nosuch' })
  assert.equal(r.ok, false)
  const methods = (r.inventory?.methods ?? {}) as Record<string, string>
  assert.ok(methods.read, 'inventory.methods 带 read 签名')
  console.log(`6. 未知方法 → 自描述清单(${Object.keys(methods).length} 方法) OK`)
}

// 7. 永不抛错: 空 channel/method
{
  const r = await reach({ channel: '', method: '' })
  assert.equal(r.ok, false)
  assert.equal(r.verdict, 'error')
  console.log('7. 空 channel/method 降级 OK')
}

console.log('\nAGENT-REACH WRAPPER TESTS: 7/7 OK(反射桥 + doctor 透传 + 自描述错误)')
