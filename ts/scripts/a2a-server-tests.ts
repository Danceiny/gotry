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
assert.equal(card.capabilities?.streaming, false, 'SSE 留切片 2,卡面如实声明')
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

await close()
console.log('A2A SERVER TESTS: 6/6 OK(card/鉴权/send+token 透传/get/cancel/fail-closed,纯离线 stub driver)')
