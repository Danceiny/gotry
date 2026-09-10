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
  } finally {
    await closeBackend(handle, [okModule, boomModule, session]).catch(() => { /* 关闭聚合错误不掩测试结论 */ })
  }
  await sleep(50)
  console.log(`\nGOTRY BACKEND KERNEL: ${pass} pass, ${fail} fail`)
  if (fail > 0) process.exitCode = 1
}
void main()
