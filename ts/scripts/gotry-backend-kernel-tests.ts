/**
 * gotry-backend 内核离线合同测试(路由精确分发/冲突拒装/404/异常隔离/模块鉴权;
 * 不发真实会话检索——session-search 模块以注入 fake 驱动)。
 */
import assert from 'node:assert/strict'


import { closeBackend, createBackendServer, type BackendModule } from '../src/backend/kernel.ts'
import { startSessionSearchModule } from '../src/backend/modules/session-search.ts'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
let pass = 0
let fail = 0
const check = (cond: boolean, label: string): void => {
  if (cond) { pass += 1; console.log(`  ok - ${label}`) } else { fail += 1; console.log(`  FAIL - ${label}`) }
}
async function jfetch(url: string, init?: RequestInit): Promise<{ status: number; body: unknown }> {
  const r = await fetch(url, init)
  let body: unknown = null
  try { body = await r.json() } catch { /* 空体 */ }
  return { status: r.status, body }
}

async function main(): Promise<void> {
  // M1 内核:路由精确分发 + 未知 404 + 异常隔离 500(进程不倒)
  const okModule: BackendModule = {
    name: 'fake-ok',
    routes: [{ method: 'GET', path: '/m1/ping', handle: (_req, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ pong: true })) } }],
  }
  const boomModule: BackendModule = {
    name: 'fake-boom',
    routes: [{ method: 'GET', path: '/m2/boom', handle: async () => { throw new Error('boom') } }],
  }
  const session = startSessionSearchModule({
    apiKey: () => 'test-key',
    search: async () => ({
      ok: true, via: 'session-dida-portal', evidence: '[会话:dida-portal@test]', latencyMs: 1, verdict: 'hit',
      rates: [{ hotelName: 'T', roomName: 'R', ratePlanId: 'RP', price: 100, currency: 'CNY', referenceNo: 'REF' }],
    }),
  })
  const handle = await createBackendServer({ modules: [okModule, boomModule, session], port: 0 })
  const base = `http://127.0.0.1:${handle.port}`
  try {
    const ping = await jfetch(`${base}/m1/ping`)
    check(ping.status === 200 && (ping.body as { pong?: boolean }).pong === true, '模块路由精确分发')
    const nf = await jfetch(`${base}/nope`)
    check(nf.status === 404 && (nf.body as { error?: { code?: string } }).error?.code === 'not_found', '未知路由 404')
    const boom = await jfetch(`${base}/m2/boom`)
    check(boom.status === 500 && (boom.body as { error?: { code?: string } }).error?.code === 'gotry_backend_module_error', '模块异常隔离 500(服务面不倒)')
    const afterBoom = await jfetch(`${base}/m1/ping`)
    check(afterBoom.status === 200, '异常后服务面存活')
    check(handle.moduleNames.includes('session-search') && handle.moduleNames.includes('fake-ok'), '模块注册表名单')

    // M2 session-search 模块:鉴权 fail-closed + 注入 fake 检索合同
    const noAuth = await jfetch(`${base}/v1/session/search`, { method: 'POST', body: '{"supplier":"dida-portal"}' })
    check(noAuth.status === 403, '无 token 403')
    const badSupplier = await jfetch(`${base}/v1/session/search`, {
      method: 'POST',
      headers: { authorization: 'Bearer test-key', 'content-type': 'application/json' },
      body: '{"supplier":"ctrip-flight"}',
    })
    check(badSupplier.status === 400, '未知供应商通道 400')
    const hit = await jfetch(`${base}/v1/session/search`, {
      method: 'POST',
      headers: { authorization: 'Bearer test-key', 'content-type': 'application/json' },
      body: '{"supplier":"dida-portal"}',
    })
    const hitBody = hit.body as { ok?: boolean; verdict?: string; rates?: Array<{ ratePlanId?: string }> }
    check(hit.status === 200 && hitBody.verdict === 'hit' && hitBody.rates?.[0]?.ratePlanId === 'RP', '注入 fake 检索:结果合同透传')

    // M2b needs-extension:安装入口是该 verdict 唯一的行动项,hotel-fe#3611
    const STORE_URL = 'https://chromewebstore.google.com/detail/gotry-session-bridge/oeajpiccmonococjcegddlooeeohlbgd'
    const extModule = startSessionSearchModule({
      apiKey: () => 'test-key',
      search: async () => ({
        ok: false,
        via: 'session-dida-portal-error',
        evidence: '[会话:dida-portal-needs-extension@test]',
        latencyMs: 1,
        verdict: 'needs-extension',
        error: 'GoTry Session Bridge 扩展未连接',
        installUrl: STORE_URL,
        installAction: 'add-to-chrome' as const,
      }),
    })
    const extHandle = await createBackendServer({ modules: [extModule], port: 0 })
    try {
      const ext = await jfetch(`http://127.0.0.1:${extHandle.port}/v1/session/search`, {
        method: 'POST',
        headers: { authorization: 'Bearer test-key', 'content-type': 'application/json' },
        body: '{"supplier":"dida-portal"}',
      })
      const extBody = ext.body as { verdict?: string; installUrl?: string; installAction?: string }
      check(ext.status === 200 && extBody.verdict === 'needs-extension', 'needs-extension verdict 透传')
      check(extBody.installUrl === STORE_URL, '安装链接随 verdict 透出')
      check(extBody.installAction === 'add-to-chrome', '安装动作随 verdict 透出')
    } finally {
      await closeBackend(extHandle, [extModule]).catch(() => { /* 同上 */ })
    }

    // M3 #483:POST search/login 输入守卫。submit / search 注入计数证明
    // 被拦截请求到达底层 = 0;/m1/ping 作 liveness 探针验证内核未被
    // unhandledRejection 拖垮。
    const submitCalls: { count: number; lastJob?: { kind: string; site: string; url?: string } } = { count: 0 }
    const fakeQueue = {
      extensionConnected: () => true,
      port: 0,
      close: async () => undefined,
      handleMountedRequest: () => undefined,
      submit: async (job: { kind: string; site: string; url?: string }) => {
        submitCalls.count += 1
        submitCalls.lastJob = job
        return { ok: true as const, result: { ok: true, opened: true } }
      },
    }
    let searchCalls = 0
    const guardSession = startSessionSearchModule({
      apiKey: () => 'test-key',
      search: async () => {
        searchCalls += 1
        return {
          ok: true, via: 'session-dida-portal', evidence: '[会话:dida-portal@test]', latencyMs: 1, verdict: 'hit',
          rates: [{ hotelName: 'T', roomName: 'R', ratePlanId: 'RP', price: 100, currency: 'CNY', referenceNo: 'REF' }],
        }
      },
      jobQueue: fakeQueue as unknown as Parameters<typeof startSessionSearchModule>[0]['jobQueue'],
    })
    const guardHandle = await createBackendServer({ modules: [okModule, guardSession], port: 0 })
    const guardBase = `http://127.0.0.1:${guardHandle.port}`
    const authHeader = { authorization: 'Bearer test-key', 'content-type': 'application/json' }
    try {
      type Case = { label: string; path: string; body: string; expectError: string }
      const rejectionCases: Case[] = [
        { label: 'search body=null', path: '/v1/session/search', body: 'null', expectError: 'body 必须是 JSON 对象' },
        { label: 'search body=[]', path: '/v1/session/search', body: '[]', expectError: 'body 必须是 JSON 对象' },
        { label: 'search body=number', path: '/v1/session/search', body: '42', expectError: 'body 必须是 JSON 对象' },
        { label: 'search body=string', path: '/v1/session/search', body: '"x"', expectError: 'body 必须是 JSON 对象' },
        { label: 'search body=bool', path: '/v1/session/search', body: 'true', expectError: 'body 必须是 JSON 对象' },
        { label: 'search supplier=number', path: '/v1/session/search', body: '{"supplier":123}', expectError: 'supplier 必须是字符串' },
        { label: 'search supplier=null', path: '/v1/session/search', body: '{"supplier":null}', expectError: 'supplier 必须是字符串' },
        { label: 'search query=string', path: '/v1/session/search', body: '{"supplier":"dida-portal","query":"foo"}', expectError: 'body 必须是 JSON 对象' },
        { label: 'search query.timeoutMs=string', path: '/v1/session/search', body: '{"supplier":"dida-portal","query":{"timeoutMs":"30"}}', expectError: 'body 必须是 JSON 对象' },
        { label: 'search query.timeoutMs=Infinity', path: '/v1/session/search', body: '{"supplier":"dida-portal","query":{"timeoutMs":1e309}}', expectError: 'body 必须是 JSON 对象' },
        { label: 'login body=null', path: '/v1/session/login/open', body: 'null', expectError: 'body 必须是 JSON 对象' },
        { label: 'login url=number', path: '/v1/session/login/open', body: '{"supplier":"dida-portal","url":123}', expectError: 'url 必须是字符串' },
        { label: 'login supplier=bool', path: '/v1/session/login/open', body: '{"supplier":true}', expectError: 'supplier 必须是字符串' },
        { label: 'search 非法 JSON', path: '/v1/session/search', body: '{not-json', expectError: 'body 不是 JSON' },
        { label: 'login 非法 JSON', path: '/v1/session/login/open', body: '{not-json', expectError: 'body 不是 JSON' },
      ]
      for (const c of rejectionCases) {
        const r = await jfetch(`${guardBase}${c.path}`, { method: 'POST', headers: authHeader, body: c.body })
        const err = (r.body as { error?: string } | null)?.error ?? ''
        check(r.status === 400, `${c.label}:HTTP 400`)
        check(err === c.expectError, `${c.label}:error 稳定(${c.expectError})`)
        const live = await jfetch(`${guardBase}/m1/ping`)
        check(live.status === 200, `${c.label}:拒后 server 存活`)
      }

      // 超 64KB 触发 readBody 拒绝;确保不抛错 / 进程不倒。
      const oversize = 'x'.repeat(64 * 1024 + 16)
      const rOversize = await jfetch(`${guardBase}/v1/session/search`, { method: 'POST', headers: authHeader, body: oversize })
      check(rOversize.status === 400 && ((rOversize.body as { error?: string } | null)?.error ?? '') === 'body 读取失败', 'search 超 64KB:HTTP 400 body 读取失败')
      const liveOversize = await jfetch(`${guardBase}/m1/ping`)
      check(liveOversize.status === 200, 'search 超 64KB:拒后 server 存活')

      check(searchCalls === 0, '所有被拒 search:search 注入 0 次调用')
      check(submitCalls.count === 0, '所有被拒 login:bridge.submit 0 次调用')

      // 合法路径需真正穿过守卫、调用底层
      const validSearch = await jfetch(`${guardBase}/v1/session/search`, {
        method: 'POST', headers: authHeader, body: '{"supplier":"dida-portal","query":{"entryUrl":"https://portal.dida.com/find","timeoutMs":5000}}',
      })
      check(validSearch.status === 200, '合法 search(query 对象含 entryUrl/timeoutMs):200')
      check(searchCalls === 1, '合法 search:search 注入 +1 次')
      const validLogin = await jfetch(`${guardBase}/v1/session/login/open`, {
        method: 'POST', headers: authHeader, body: '{"supplier":"dida-portal","url":"https://portal.dida.com/login"}',
      })
      check(validLogin.status === 200, '合法 login/open:200')
      check(submitCalls.count === 1 && submitCalls.lastJob?.kind === 'open-login', '合法 login:bridge.submit +1 次且 kind=open-login')

      const offDomain = await jfetch(`${guardBase}/v1/session/login/open`, {
        method: 'POST', headers: authHeader, body: '{"supplier":"dida-portal","url":"https://evil.example.com/login"}',
      })
      check(offDomain.status === 400 && ((offDomain.body as { error?: string } | null)?.error ?? '').includes('portal.dida.com'), 'login url 域外 400(fail-closed)')
      check(submitCalls.count === 1, 'login url 域外:bridge.submit 未增')
    } finally {
      await closeBackend(guardHandle, [okModule, guardSession])
    }
  } finally {
    await closeBackend(handle, [okModule, boomModule, session]).catch(() => { /* 关闭聚合错误不掩测试结论 */ })
  }
  await sleep(50)
  console.log(`\nGOTRY BACKEND KERNEL: ${pass} pass, ${fail} fail`)
  if (fail > 0) process.exitCode = 1
}
void main()
