/**
 * agent-reach 能力层测试(r.jina.ai 不可用时,起本地 server 自喂):
 *  1. 真实 URL 读取: 本地 server 返 markdown 内容(无需 r.jina.ai 网络)
 *  2. 非法 URL(不带 http): 拒绝,不抛错,降级返回
 *  3. 超时: 用 1ms timeout 触发 abort,返回 error
 *  4. 证据链: 每次调用标 [agent-reach:r.jina.ai@ts]
 *
 * 之前的 case 1 真连 r.jina.ai(失败时挂在 §13 全栈);
 * 改本地 server 后离线可跑,生产路径不变。
 *
 * 运行: cd ts && npx tsx scripts/agent-reach-tests.ts
 */

import assert from 'node:assert/strict'
import { createServer, IncomingMessage, ServerResponse } from 'node:http'
import { readUrl } from '../capabilities/agent-reach.ts'

let baseUrl = ''

// 起本地 server: /echo 返 markdown 头 + 路径, /slow 故意 hang
{
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const p = req.url?.replace(/^\/[^/]+\//, "")?.replace(/^https?:\/\//, "") || "";
    if (p === "echo" || req.url === "/echo") {
      res.writeHead(200, { 'Content-Type': 'text/markdown' })
      res.end(`# Echo\n\nURL Source: ${req.url}\n\nHello, this is local fixture.`)
    } else if (req.url === '/slow') {
      // 故意不响应,等超时
      return
    } else {
      res.writeHead(404); res.end()
    }
  })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  const addr = server.address()
  baseUrl = `http://127.0.0.1:${addr.port}`
  ;(globalThis as Record<string, unknown>).__testServer = server
}

// 1. 真实 URL 读取(本地 server /echo 返 markdown)
{
  const r = await readUrl({ url: `${baseUrl}/echo`, baseUrl })
  assert.equal(r.ok, true, `应 ok,实际 error=${r.error}`)
  assert.equal(r.via, 'r.jina.ai')
  assert.ok(r.evidence.includes('agent-reach:r.jina.ai'), '证据链')
  assert.ok(typeof r.content === 'string' && r.content.length > 0, 'content 非空')
  assert.ok(r.latencyMs > 0, 'latency>0')
  assert.match(r.content!, /Echo/, 'markdown 含 # Echo 头')
  console.log(`1. readUrl ${baseUrl}/echo → ok (${r.content?.slice(0, 60).replace(/\n/g, ' ')}…) OK`)
}

// 2. 非法 URL(不带 scheme)
{
  const r = await readUrl({ url: 'example.com' })
  assert.equal(r.ok, false)
  assert.equal(r.via, 'r.jina.ai-error')
  assert.ok(r.evidence.includes('error'), 'evidence 带 error')
  console.log('2. 非法 URL 拒绝 OK')
}

// 3. 超时(本地 /slow hang)
{
  const r = await readUrl({ url: `${baseUrl}/slow`, timeoutMs: 50, baseUrl })
  assert.equal(r.ok, false)
  assert.equal(r.via, 'r.jina.ai-error')
  console.log('3. 超时降级 OK')
}

// 4. 证据链包含时间戳
{
  const r = await readUrl({ url: `${baseUrl}/echo`, baseUrl })
  assert.match(r.evidence, /\[agent-reach:r\.jina\.ai@2\d{3}-\d{2}-\d{2}T/, '证据链带 ISO 时间戳')
  console.log('4. 证据链时间戳 OK')
}

// 收尾:关 server
{
  const s = (globalThis as { __testServer?: { close: (cb?: () => void) => void } }).__testServer
  s?.close()
}

console.log('\nAGENT-REACH TESTS: 4/4 OK(r.jina.ai mock by 本地 server,无外网依赖)')
