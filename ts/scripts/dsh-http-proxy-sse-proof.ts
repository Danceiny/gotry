/**
 * dsh-http-proxy 本地 SSE + 中毒 HTTP 代理反例(issue #268):启动回环 SSE 服务器和
 * 统计命中次数的中毒代理,用公共 installProxyFromEnvironment API 安装代理策略,
 * 将 HTTP(S)_PROXY 指向中毒代理。在 127.0.0.1 上获取 SSE 端点,断言负载成功且
 * 中毒命中计数保持为零;同时断言 proxyRouteFor(loopback) 是直接的,非回环 URL
 * 被分类为代理,且 proxyEnvironmentForChild() 携带回环 NO_PROXY 以及 Node 24 下的
 * NODE_USE_ENV_PROXY。始终 await 返回的 disposer 并在 finally 中关闭两个服务器;
 * 证明全局路由返回到先前的直接状态。
 *
 * 运行:cd ts && npx tsx scripts/dsh-http-proxy-sse-proof.ts
 */
import assert from 'node:assert/strict'
import http from 'node:http'
import { installProxyFromEnvironment, proxyRouteFor, proxyEnvironmentForChild } from '@deepseek-ai/dsh-http-proxy'

// 1. 回环 SSE 服务器。
const sseServer = http.createServer((req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  })
  res.write('data: hello-sse\n\n')
  res.end()
})
await new Promise<void>((resolve) => sseServer.listen(0, '127.0.0.1', resolve))
const sseAddr = sseServer.address()
assert.ok(sseAddr !== null && typeof sseAddr === 'object', 'SSE 服务器必须已绑定地址')
const ssePort = sseAddr.port
const sseUrl = `http://127.0.0.1:${ssePort}/`

// 2. 中毒代理:统计命中次数,返回 502。
let poisonHits = 0
const poisonServer = http.createServer((req, res) => {
  poisonHits++
  res.writeHead(502)
  res.end('poisoned')
})
await new Promise<void>((resolve) => poisonServer.listen(0, '127.0.0.1', resolve))
const poisonAddr = poisonServer.address()
assert.ok(poisonAddr !== null && typeof poisonAddr === 'object', '中毒代理必须已绑定地址')
const poisonPort = poisonAddr.port

let disposer: (() => Promise<void>) | undefined
try {
  // 3. 用公共 installProxyFromEnvironment API 安装代理策略,指向中毒代理。
  const envMap = new Map<string, string>([
    ['HTTP_PROXY', `http://127.0.0.1:${poisonPort}`],
    ['HTTPS_PROXY', `http://127.0.0.1:${poisonPort}`],
  ])
  const envLookup = {
    get(name: string) {
      const v = envMap.get(name) ?? envMap.get(name.toLowerCase())
      return v !== undefined ? { value: v } : undefined
    },
  }
  disposer = await installProxyFromEnvironment(envLookup, () => {})

  // 4. proxyRouteFor(loopback) 是直接的;非回环 URL 被分类为代理。
  const loopbackRoute = proxyRouteFor(new URL(sseUrl))
  assert.equal(loopbackRoute.proxied, false, '回环 URL 必须路由为直接(proxyRouteFor)')

  const externalRoute = proxyRouteFor(new URL('http://example.com/'))
  assert.equal(externalRoute.proxied, true, '非回环 URL 必须被分类为代理(proxyRouteFor)')

  // 5. proxyEnvironmentForChild() 携带回环 NO_PROXY 以及 Node 24 下的 NODE_USE_ENV_PROXY。
  const childEnv = proxyEnvironmentForChild()
  assert.equal(childEnv.NODE_USE_ENV_PROXY, '1', 'proxyEnvironmentForChild 必须携带 NODE_USE_ENV_PROXY=1(Node 24)')
  assert.ok(
    typeof childEnv.NO_PROXY === 'string' && childEnv.NO_PROXY.includes('127.0.0.1'),
    `proxyEnvironmentForChild NO_PROXY 必须包含 127.0.0.1(当前 ${JSON.stringify(childEnv.NO_PROXY)})`,
  )

  // 6. 在 127.0.0.1 上获取 SSE 端点:负载成功且中毒命中计数保持为零。
  const resp = await fetch(sseUrl)
  assert.equal(resp.status, 200, `SSE fetch 必须成功(status=${resp.status})`)
  const body = await resp.text()
  assert.ok(body.includes('hello-sse'), `SSE 负载必须包含 hello-sse(当前 ${JSON.stringify(body)})`)
  assert.equal(poisonHits, 0, `中毒代理命中计数必须为零(当前 ${poisonHits})——回环绕过代理`)
} finally {
  // 7. 始终 await 返回的 disposer 并在 finally 中 await 关闭两个服务器(包括失败路径)。
  //    不依赖未 await 的 server.close() 让进程退出——显式 await 完成资源清理。
  try {
    if (disposer) await disposer()
  } finally {
    await Promise.all([
      new Promise<void>((resolve, reject) => sseServer.close((err) => (err ? reject(err) : resolve()))),
      new Promise<void>((resolve, reject) => poisonServer.close((err) => (err ? reject(err) : resolve()))),
    ])
  }
}

// 8. 证明全局路由返回到先前的直接状态。
const externalAfter = proxyRouteFor(new URL('http://example.com/'))
assert.equal(externalAfter.proxied, false, 'disposer 后全局路由必须返回直接状态')

console.log(
  `HTTP PROXY SSE PROOF: loopback SSE fetch=200 payload-has-hello-sse=true poison-hits=0, ` +
    `loopback route=direct external route=proxied, NODE_USE_ENV_PROXY=1 NO_PROXY has 127.0.0.1, ` +
    `routing restored to direct after dispose`,
)