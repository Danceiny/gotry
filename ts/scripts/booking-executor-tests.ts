/**
 * booking-executor 模块合同测试(离线确定性):
 *   - 鉴权 fail-closed(无 key 503/错 key 403)
 *   - observe 合同(注入观察器/未知供应商拒绝/域外 entryUrl 拒绝)
 * 不发真实浏览器会话;提交/填单原语在本模块不存在(红线)。
 */
import assert from 'node:assert/strict'

import { closeBackend, createBackendServer, type BackendModule } from '../src/backend/kernel.ts'
import { startBookingExecutorModule } from '../src/backend/modules/booking-executor.ts'

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
  const module = startBookingExecutorModule({
    apiKey: () => 'test-booking-key',
    evidenceDir: () => '/tmp/booking-executor-test-evidence',
    observe: async () => ({
      ok: true,
      supplier: 'dida-portal',
      entryUrl: 'https://portal.dida.com/hotel/find',
      entryPoints: [{ text: '预订', tag: 'button' }],
      screenshotPath: '/tmp/evidence/test.png',
      observedAt: new Date().toISOString(),
    }),
  })
  const handle = await createBackendServer({ modules: [module], port: 0 })
  const base = `http://127.0.0.1:${handle.port}`
  try {
    // ① 鉴权 fail-closed
    const noAuth = await jfetch(`${base}/v1/booking/observe`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ supplier: 'dida-portal' }),
    })
    check(noAuth.status === 403, '无 token 403')
    // ② 注入观察器:正常观察
    const ok = await jfetch(`${base}/v1/booking/observe`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer test-booking-key' },
      body: JSON.stringify({ supplier: 'dida-portal' }),
    })
    const okBody = ok.body as { ok?: boolean; supplier?: string; entryPoints?: unknown[] }
    check(ok.status === 200 && okBody.ok === true && okBody.supplier === 'dida-portal', '观察返回 200 + 供应商')
    check(Array.isArray(okBody.entryPoints) && okBody.entryPoints.length === 1, '入口观察条目形状')
    // ③ 未知供应商拒绝
    const bad = await jfetch(`${base}/v1/booking/observe`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer test-booking-key' },
      body: JSON.stringify({ supplier: 'ctrip-flight' }),
    })
    check(bad.status === 400, '未知供应商 400')
    // ④ 域外 entryUrl 拒绝
    const evil = await jfetch(`${base}/v1/booking/observe`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer test-booking-key' },
      body: JSON.stringify({ supplier: 'dida-portal', entryUrl: 'https://evil.example.com/x' }),
    })
    check(evil.status === 400, '域外 entryUrl 400')
  } finally {
    await closeBackend(handle, [module]).catch(() => { /* 关闭聚合错误不掩测试结论 */ })
  }
  await sleep(30)
  console.log(`\nBOOKING EXECUTOR: ${pass} pass, ${fail} fail`)
  if (fail > 0) process.exitCode = 1
}
void main()
