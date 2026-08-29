/**
 * A2A 入口骨架测试(M2 切片 1,纯离线 stub driver;真对话 headless 接线在切片 2)。
 *  1. Agent Card:GET /.well-known/agent-card.json 形状(技能 nl-hotel-booking)
 *  2. 鉴权:无/错 Bearer → HTTP 401(JSON-RPC error 面)
 *  3. message/send:userToken 透传到 driver(env 装配断言)+ 任务终态 completed + artifact
 *  4. tasks/get:未知 id → -32002;终态任务回读 artifacts
 *  5. tasks/cancel:working 任务 → canceled;终态再取消 → -32003
 *  6. fail-closed:无 apiKey 拒绝启动
 * 运行: cd ts && npx tsx scripts/a2a-server-tests.ts
 */

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildHeadlessDriverEnv, startA2AServer, type A2ADriver } from '../src/a2a-server.ts'
import { makeHeadlessDriver, userStateRoot } from '../src/a2a-driver.ts'
import { createHash } from 'node:crypto'
const createHashDemo = (t: string) => `u-${createHash('sha256').update(t).digest('hex').slice(0, 12)}`

const KEY = 'test-a2a-key'

// headless driver 环境装配:token 透传/状态隔离/日历剔除(不落 token 值)
const tmpState = mkdtempSync(join(tmpdir(), 'a2a-env-'))
const env = buildHeadlessDriverEnv('ST:test-token-xyz', tmpState)
assert.equal(env.HOTELBYTE_TOKEN, 'ST:test-token-xyz', 'userToken 原样透传 HOTELBYTE_TOKEN')
assert.equal(env.GOTRY_STATE_ROOT, tmpState, 'per-user 状态隔离')
assert.equal(env.GOTRY_NO_CALENDAR, '1')
rmSync(tmpState, { recursive: true, force: true })
console.log('0. headless env 装配(token 透传/状态隔离)OK')

let seenToken: string | undefined
const stubDriver: A2ADriver = async ({ text, userToken }) => {
  seenToken = userToken
  await new Promise((r) => setTimeout(r, 30))
  return { text: `echo:${text}` }
}

const { port, close } = await startA2AServer({ apiKey: KEY, driver: stubDriver })
const base = `http://127.0.0.1:${port}`

// 1. Agent Card
const cardResp = await fetch(`${base}/.well-known/agent-card.json`)
assert.equal(cardResp.status, 200)
const card = (await cardResp.json()) as { name?: string; url?: string; skills?: Array<{ id?: string }>; capabilities?: { streaming?: boolean } }
assert.equal(card.name, 'gotry')
assert.equal(card.url, `${base}/a2a`)
assert.equal(card.skills?.[0]?.id, 'nl-hotel-booking')
assert.equal(card.capabilities?.streaming, true, '切片 2 起 SSE 在列,卡面如实声明')
console.log('1. Agent Card(name/url/技能/能力如实)OK')

// 2. 鉴权 fail-closed
const noAuth = await fetch(`${base}/a2a`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'message/send', params: {} }) })
assert.equal(noAuth.status, 401)
const badAuth = await fetch(`${base}/a2a`, { method: 'POST', headers: { authorization: 'Bearer wrong', 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'message/send', params: {} }) })
assert.equal(badAuth.status, 401)
console.log('2. 鉴权(无/错 Bearer → 401)OK')

// 3. message/send → completed + artifact + token 透传
const send = await fetch(`${base}/a2a`, {
  method: 'POST',
  headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 10, method: 'message/send', params: { message: { role: 'user', parts: [{ kind: 'text', text: '查大理两晚报价' }] }, metadata: { userToken: 'ST:u1' } } }),
})
const sendBody = (await send.json()) as { result?: { taskId?: string; state?: string } }
const taskId = sendBody.result?.taskId
assert.ok(taskId, 'message/send 应返回 taskId')
type TaskView = { result?: { state?: string; artifacts?: Array<{ text?: string }> } }
let task: TaskView | null = null
for (let i = 0; i < 50; i++) {
  const g = await fetch(`${base}/a2a`, { method: 'POST', headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 11, method: 'tasks/get', params: { id: taskId } }) })
  task = (await g.json()) as TaskView
  if (task?.result?.state === 'completed' || task?.result?.state === 'failed') break
  await new Promise((r) => setTimeout(r, 20))
}
assert.equal(task?.result?.state, 'completed', 'stub driver 终态 completed')
assert.equal(task?.result?.artifacts?.[0]?.text, 'echo:查大理两晚报价')
assert.equal(seenToken, 'ST:u1', 'metadata.userToken 透传到 driver')
console.log('3. message/send(taskId→completed+artifact+token 透传)OK')

// 4. tasks/get 未知 id
const unk = await fetch(`${base}/a2a`, { method: 'POST', headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 12, method: 'tasks/get', params: { id: 'no-such' } }) })
const unkBody = (await unk.json()) as { error?: { code?: number } }
assert.equal(unkBody.error?.code, -32002)
console.log('4. tasks/get 未知 id(-32002)OK')

// 5. cancel:慢任务可取消,终态不可再取消
let release: () => void = () => {}
const gate = new Promise<void>((r) => { release = r })
const { port: p2, close: c2, } = await startA2AServer({ apiKey: KEY, driver: async ({ text }) => { await gate; return { text } } })
const send2 = await fetch(`http://127.0.0.1:${p2}/a2a`, { method: 'POST', headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 20, method: 'message/send', params: { message: { parts: [{ kind: 'text', text: '慢任务' }] } } }) })
const t2 = ((await send2.json()) as { result?: { taskId?: string } }).result?.taskId
const cancelResp = await fetch(`http://127.0.0.1:${p2}/a2a`, { method: 'POST', headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 21, method: 'tasks/cancel', params: { id: t2 } }) })
const cancelBody = (await cancelResp.json()) as { result?: { state?: string } }
assert.equal(cancelBody.result?.state, 'canceled')
release()
await c2()
const cancelAgain = await fetch(`${base}/a2a`, { method: 'POST', headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 22, method: 'tasks/cancel', params: { id: taskId } }) })
const againBody = (await cancelAgain.json()) as { error?: { code?: number } }
assert.equal(againBody.error?.code, -32003, '终态任务不可取消')
console.log('5. tasks/cancel(working→canceled;终态拒 -32003)OK')

// 6. fail-closed:无 apiKey 拒绝启动
let refused = false
try { await startA2AServer({ apiKey: '' }) } catch { refused = true }
assert.ok(refused, '无 apiKey 应拒绝启动')
console.log('6. fail-closed(无 apiKey 拒启)OK')

// 7. message/stream(SSE):status(submitted/working)→final(产物)帧序;error 帧走失败 driver
{
  const stream = await fetch(`${base}/a2a`, {
    method: 'POST',
    headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json', accept: 'text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 30, method: 'message/stream', params: { message: { parts: [{ kind: 'text', text: '流式查价' }] }, metadata: { userToken: 'ST:u2' } } }),
  })
  assert.equal(stream.status, 200)
  assert.match(String(stream.headers.get('content-type') ?? ''), /text\/event-stream/, 'SSE content-type')
  const body = await stream.text()
  assert.match(body, /event: status\ndata: .*submitted/, '首帧 status=submitted')
  assert.match(body, /event: status\ndata: .*working/, '次帧 status=working')
  assert.match(body, /event: final\ndata: .*echo:流式查价/, '终帧 final 携产物')
  assert.ok(!body.includes('event: error'), '成功流无 error 帧')
  console.log('7. message/stream(SSE 帧序 submitted→working→final,诚实流无伪造增量)OK')
}
{
  const { port: p3, close: c3 } = await startA2AServer({ apiKey: KEY, driver: async () => { throw new Error('driver down') } })
  const errStream = await fetch(`http://127.0.0.1:${p3}/a2a`, {
    method: 'POST',
    headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json', accept: 'text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 31, method: 'message/stream', params: { message: { parts: [{ kind: 'text', text: 'x' }] } } }),
  })
  const errBody = await errStream.text()
  assert.match(errBody, /event: error\ndata: .*driver down/, '失败 driver → error 帧')
  await c3()
  console.log('8. message/stream 失败面(error 帧,不伪装完成)OK')
}

// 9/10. M3 治理面:per-IP 限流(429)+ 指标快照(同款 Bearer)
{
  const { port: p4, close: c4 } = await startA2AServer({ apiKey: KEY, driver: stubDriver, rateLimitPerMin: 3 })
  const fire = () => fetch(`http://127.0.0.1:${p4}/a2a`, { method: 'POST', headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 40, method: 'tasks/get', params: { id: 'x' } }) })
  const codes: number[] = []
  for (let i = 0; i < 5; i++) codes.push((await fire()).status)
  assert.deepEqual(codes.slice(0, 3), [200, 200, 200], '限流窗内前 3 个请求放行')
  assert.ok(codes.slice(3).every((c) => c === 429), `超额应 429,实际 ${codes.slice(3)}`)
  const m = await fetch(`http://127.0.0.1:${p4}/a2a/metrics`, { headers: { authorization: `Bearer ${KEY}` } })
  assert.equal(m.status, 200)
  const mv = (await m.json()) as { requestsTotal?: number; rateLimitedTotal?: number; rateLimitPerMin?: number; uptimeSec?: number }
  assert.equal(mv.requestsTotal, 5, 'requestsTotal 计满')
  assert.equal(mv.rateLimitedTotal, 2, '限流计数=2')
  assert.equal(mv.rateLimitPerMin, 3)
  assert.ok(typeof mv.uptimeSec === 'number')
  const mNoAuth = await fetch(`http://127.0.0.1:${p4}/a2a/metrics`)
  assert.equal(mNoAuth.status, 401, 'metrics 无鉴权拒绝')
  await c4()
  console.log('9. per-IP 限流(3/min 窗:3 放行/超额 429)OK')
  console.log('10. 指标面(requestsTotal/rateLimitedTotal/uptime;同款 Bearer)OK')
}

// 11. headless 真对话 driver 接线:无 LLM key → 任务诚实 failed(错误面含指引);
//     per-user stateRoot 哈希派生(不落 token 值);活体对话验证由 key 门控(部署后续期即通)
{
  const tmpBase = mkdtempSync(join(tmpdir(), 'a2a-driver-'))
  const su = userStateRoot(tmpBase, 'ST:driver-u1')
  const sa = userStateRoot(tmpBase)
  assert.ok(su.endsWith(createHashDemo('ST:driver-u1')), 'per-user 根由 token 哈希派生')
  assert.notEqual(su, sa, '匿名与具名根分离')
  assert.ok(su.includes('u-'), '根形如 u-<hash12>')
  // driver 在无 key 环境下的诚实失败(inner 自身 fail-closed:缺 DEEPSEEK_API_KEY 即退 1)
  const noKeyEnv: Record<string, string | undefined> = {}
  for (const k of Object.keys(process.env)) if (k !== 'DEEPSEEK_API_KEY' && k !== 'LLM_API_KEY') noKeyEnv[k] = process.env[k]
  const driver = makeHeadlessDriver({ stateBase: tmpBase, env: noKeyEnv, timeoutMs: 60_000 })
  const { port: p5, close: c5 } = await startA2AServer({ apiKey: KEY, driver })
  const send5 = await fetch(`http://127.0.0.1:${p5}/a2a`, {
    method: 'POST',
    headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 50, method: 'message/send', params: { message: { parts: [{ kind: 'text', text: '查大理报价' }] }, metadata: { userToken: 'ST:driver-u1' } } }),
  })
  const t5 = ((await send5.json()) as { result?: { taskId?: string } }).result?.taskId
  type TaskView5 = { result?: { state?: string; error?: string } }
  let v5: TaskView5 | null = null
  for (let i = 0; i < 100; i++) {
    const g = await fetch(`http://127.0.0.1:${p5}/a2a`, { method: 'POST', headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 51, method: 'tasks/get', params: { id: t5 } }) })
    v5 = (await g.json()) as TaskView5
    if (v5?.result?.state === 'completed' || v5?.result?.state === 'failed') break
    await new Promise((r) => setTimeout(r, 100))
  }
  assert.equal(v5?.result?.state, 'failed', '无 key 环境下任务应诚实 failed(不伪装应答)')
  await c5()
  rmSync(tmpBase, { recursive: true, force: true })
  console.log('11. headless driver 接线(无 key 诚实 failed;per-user 根派生;活体验证待 key)OK')
}

await close()
console.log('A2A SERVER TESTS: 11/11 OK(card/鉴权/send+token 透传/get/cancel/fail-closed/SSE 流式+失败面/限流+指标/headless driver 接线,纯离线)')
