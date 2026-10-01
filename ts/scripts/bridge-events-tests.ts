/**
 * 桥事件上行测试(§70;批次 B「事件上行端点 + 扩展 workspace 事件监听」,2026-10-01)。
 *
 * 全离线确定性:隔离 stateRoot(mkdtemp)+ 临时端口 gotry-backend 内核(createBackendServer
 * 真实 HTTP 面,零网络出站、零真实供应商、零真实凭据、不写共享状态)。
 *
 * 覆盖(规格批次 B §5):
 *   ① 鉴权链(与 /jobs 同链):缺 key 503 fail-closed / 错 bearer 403 /
 *      错 Origin 403 / 无 Origin 403(网页跨域请求必带邪恶 Origin)/ 商店源白名单放行;
 *   ② 形状守卫:非 JSON 400 / 顶层非对象 400 / clientId 缺失或非 UUID 400 / events 非数组 400;
 *   ③ 批量写入:混合批次逐条裁决 {ok:true,accepted,rejected};bridge_events 行列级断言
 *      (seq AUTOINCREMENT 单调 / ts 服务端时刻 / site 缺省 NULL / payload_json 原样落账);
 *   ④ idem 幂等:idem_key 重发不重复落行(accepted:0);批内重复 idem_key 首 accepted 次
 *      rejected;NULL idem_key 不参与去重(部分唯一索引,多行共存);
 *   ⑤ 超限 400:body >256KB 整批拒绝且零行落账(路由直驱,确定性触发流中截断);
 *   ⑥ 无账本形态(缺 stateRoot 纯内存):503 fail-closed——事件无处落账,不假成功。
 */

import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import Database from 'better-sqlite3'
import type { IncomingMessage, ServerResponse } from 'node:http'

import { EXTENSION_ORIGIN, EXTENSION_ORIGIN_STORE } from '../capabilities/session/extension-bridge.ts'
import { bridgeLedgerDbPath, type BridgeEventRow } from '../capabilities/session/bridge-ledger.ts'
import { BRIDGE_EVENTS_BODY_LIMIT, BRIDGE_EVENTS_PATH, startSessionSearchModule } from '../src/backend/modules/session-search.ts'
import { closeBackend, createBackendServer, type BackendModule, type BackendServerHandle } from '../src/backend/kernel.ts'

let passed = 0
async function check(label: string, assertion: () => void | Promise<void>): Promise<void> {
  await assertion()
  passed += 1
  console.log(`  ok - ${label}`)
}

interface JsonResult {
  status: number
  body: Record<string, unknown>
}

async function jfetch(url: string, init: RequestInit = {}): Promise<JsonResult> {
  const r = await fetch(url, init)
  const text = await r.text()
  let body: Record<string, unknown>
  try {
    body = JSON.parse(text) as Record<string, unknown>
  } catch {
    body = { raw: text }
  }
  return { status: r.status, body }
}

/** 事件上行请求(默认合法链:bearer events-key + unpacked 扩展 Origin + JSON 体) */
function eventsRequest(base: string, clientId: string, events: ReadonlyArray<Record<string, unknown>>, opts: { authorization?: string; origin?: string | null } = {}): Promise<JsonResult> {
  const headers: Record<string, string> = { 'content-type': 'application/json', authorization: opts.authorization ?? 'Bearer events-key' }
  if (opts.origin !== null) headers.origin = opts.origin ?? EXTENSION_ORIGIN
  return jfetch(`${base}${BRIDGE_EVENTS_PATH}`, { method: 'POST', headers, body: JSON.stringify({ clientId, events }) })
}

/** 只读快照:bridge_events 全行(seq 升序) */
function readEvents(stateRoot: string): BridgeEventRow[] {
  const raw = new Database(bridgeLedgerDbPath(stateRoot), { readonly: true })
  try {
    return raw.prepare(`SELECT seq, ts, client_id, kind, site, subject, payload_json, idem_key FROM bridge_events ORDER BY seq`).all() as BridgeEventRow[]
  } finally {
    raw.close()
  }
}

/**
 * 路由直驱(超限例专用):真 HTTP 下服务端 400 早于请求体发完,socket 语义跨 Node 版本
 * 不确定;直驱以 data 事件确定性触发 readBody 流中截断,响应语义与真链路同一处理器。
 */
async function driveEventsRoute(mod: BackendModule, headers: Record<string, string>, body: string): Promise<{ statusCode: number; body: string }> {
  const req = new EventEmitter() as unknown as IncomingMessage
  Object.assign(req as unknown as Record<string, unknown>, { method: 'POST', url: BRIDGE_EVENTS_PATH, headers })
  let statusCode = 200
  let settle!: (v: { statusCode: number; body: string }) => void
  const done = new Promise<{ statusCode: number; body: string }>((resolve) => { settle = resolve })
  const res = {
    get statusCode(): number { return statusCode },
    set statusCode(v: number) { statusCode = v },
    setHeader: (): void => { /* 测试不读头 */ },
    end: (chunk?: unknown): void => { settle({ statusCode, body: typeof chunk === 'string' ? chunk : '' }) },
  }
  const route = mod.routes.find((r) => r.method === 'POST' && r.path === BRIDGE_EVENTS_PATH)
  if (!route) throw new Error(`session-search 模块应注册 POST ${BRIDGE_EVENTS_PATH}`)
  route.handle(req, res as unknown as ServerResponse)
  // 分两半投喂:首块已超限,处理器须在流中立即 400,不得等 end
  const half = Math.ceil(body.length / 2)
  req.emit('data', Buffer.from(body.slice(0, half)))
  req.emit('data', Buffer.from(body.slice(half)))
  req.emit('end')
  return done
}

async function main(): Promise<void> {
  console.log('§70 桥事件上行(bridge events,全离线)')

  const CLIENT = randomUUID()
  const root = mkdtempSync(join(tmpdir(), 'gotry-bridge-events-'))
  const mod = startSessionSearchModule({ apiKey: () => 'events-key', stateRoot: root })
  const noKeyMod = startSessionSearchModule({ apiKey: () => '', stateRoot: root })
  const noLedgerMod = startSessionSearchModule({ apiKey: () => 'events-key' })

  let handle: BackendServerHandle
  let noKeyHandle: BackendServerHandle
  let noLedgerHandle: BackendServerHandle
  try {
    handle = await createBackendServer({ modules: [mod], port: 0 })
    noKeyHandle = await createBackendServer({ modules: [noKeyMod], port: 0 })
    noLedgerHandle = await createBackendServer({ modules: [noLedgerMod], port: 0 })
    const base = `http://127.0.0.1:${handle.port}`

    /* ---------- ① 鉴权链(与 /jobs 同链) ---------- */

    await check('缺 key 503 fail-closed(内核注册路由 + authorized 前置,与 /jobs 同链)', async () => {
      const r = await eventsRequest(`http://127.0.0.1:${noKeyHandle.port}`, CLIENT, [])
      assert.equal(r.status, 503)
      assert.equal(r.body.ok, false)
      assert.ok(String(r.body.error).includes('fail-closed'))
    })

    await check('错 bearer 403 forbidden', async () => {
      const r = await eventsRequest(base, CLIENT, [], { authorization: 'Bearer wrong-key' })
      assert.equal(r.status, 403)
      assert.equal(r.body.error, 'forbidden')
    })

    await check('错 Origin 403(扩展 Origin 白名单在 bearer 之上再强制;双通道白名单外一律拒)', async () => {
      const evil = await jfetch(`${base}${BRIDGE_EVENTS_PATH}`, {
        method: 'POST',
        headers: { authorization: 'Bearer events-key', 'content-type': 'application/json', origin: 'https://evil.example' },
        body: JSON.stringify({ clientId: CLIENT, events: [] }),
      })
      assert.equal(evil.status, 403)
      assert.equal(evil.body.error, 'origin 不在桥白名单')
      const none = await eventsRequest(base, CLIENT, [], { origin: null })
      assert.equal(none.status, 403, '无 Origin(非扩展 fetch 形态)同样拒绝')
    })

    await check('商店源(EXTENSION_ORIGIN_STORE)在白名单内放行(unpacked+商店双通道同 /jobs)', async () => {
      const r = await eventsRequest(base, CLIENT, [], { origin: EXTENSION_ORIGIN_STORE })
      assert.equal(r.status, 200)
      assert.deepEqual(r.body, { ok: true, accepted: 0, rejected: 0 })
    })

    /* ---------- ② 形状守卫 ---------- */

    await check('形状守卫:非 JSON / 顶层非对象 / clientId 缺失或非 UUID / events 非数组均 400', async () => {
      const post = async (rawBody: string): Promise<JsonResult> =>
        jfetch(`${base}${BRIDGE_EVENTS_PATH}`, {
          method: 'POST',
          headers: { authorization: 'Bearer events-key', 'content-type': 'application/json', origin: EXTENSION_ORIGIN },
          body: rawBody,
        })
      assert.equal((await post('not-json')).body.error, 'body 不是 JSON')
      assert.equal((await post('[]')).body.error, 'body 必须是 JSON 对象')
      assert.equal((await post(JSON.stringify({ events: [] }))).status, 400, 'clientId 缺失 400')
      assert.equal((await post(JSON.stringify({ clientId: 'not-a-uuid', events: [] }))).status, 400, 'clientId 非 UUID 400')
      assert.equal((await post(JSON.stringify({ clientId: CLIENT }))).body.error, 'events 必须是数组')
      for (const r of [await post('not-json'), await post('[]')]) assert.equal(r.status, 400)
    })

    /* ---------- ③ 批量写入 ---------- */

    const t0 = Date.now()
    await check('批量写入:混合批次逐条裁决 {ok:true,accepted:2,rejected:2};行列级断言(seq 单调/ts 服务端时刻/site 缺省 NULL/payload_json 原样)', async () => {
      const r = await eventsRequest(base, CLIENT, [
        { kind: 'workspace-open', site: 'portal.hotelbyte.com', subject: 'workspace-42', payload_json: '{"tab":"flights"}', clientTs: 1_728_000_000_000, idem_key: 'evt-1' },
        { kind: 'workspace-open', subject: 'workspace-43', payload_json: 'plain-text-payload-stays-verbatim' },
        { kind: '', site: 'portal.hotelbyte.com', subject: 'bad-kind', payload_json: '{}' },
        { kind: 'workspace-open', site: 'portal.hotelbyte.com', subject: 'bad-client-ts', payload_json: '{}', clientTs: 'yesterday' },
      ])
      assert.equal(r.status, 200)
      assert.deepEqual(r.body, { ok: true, accepted: 2, rejected: 2 })
      const rows = readEvents(root)
      assert.equal(rows.length, 2, '只有两条合法事件落账')
      const [a, b] = rows
      assert.ok(a.seq < b.seq, 'seq AUTOINCREMENT 单调递增')
      assert.equal(a.client_id, CLIENT)
      assert.equal(a.kind, 'workspace-open')
      assert.equal(a.site, 'portal.hotelbyte.com')
      assert.equal(a.subject, 'workspace-42')
      assert.equal(a.payload_json, '{"tab":"flights"}')
      assert.equal(a.idem_key, 'evt-1')
      // clientTs 只参与形状校验不入列——账本唯一时间轴是服务端 ts
      assert.ok(a.ts >= t0 && a.ts <= Date.now(), 'ts 为服务端落账时刻(epoch 毫秒)')
      assert.equal(b.site, null, 'site 缺省落 NULL')
      assert.equal(b.idem_key, null, 'idem_key 缺省落 NULL')
      assert.equal(b.payload_json, 'plain-text-payload-stays-verbatim', 'payload_json 原样落账(不二次解析)')
    })

    /* ---------- ④ idem 幂等 ---------- */

    await check('idem 幂等:同 idem_key 整批重发 accepted:0 rejected:1,行数不变(重试不重复落行)', async () => {
      const r = await eventsRequest(base, CLIENT, [
        { kind: 'workspace-open', site: 'portal.hotelbyte.com', subject: 'workspace-42-retry', payload_json: '{"tab":"flights"}', idem_key: 'evt-1' },
      ])
      assert.deepEqual(r.body, { ok: true, accepted: 0, rejected: 1 })
      assert.equal(readEvents(root).length, 2, '幂等去重后行数不变')
    })

    await check('idem 幂等:批内重复 idem_key 首 accepted 次 rejected(同批不重复落行)', async () => {
      const r = await eventsRequest(base, CLIENT, [
        { kind: 'workspace-open', site: 'portal.hotelbyte.com', subject: 'ws-a', payload_json: '{}', idem_key: 'dup-key' },
        { kind: 'workspace-open', site: 'portal.hotelbyte.com', subject: 'ws-b', payload_json: '{}', idem_key: 'dup-key' },
      ])
      assert.deepEqual(r.body, { ok: true, accepted: 1, rejected: 1 })
      const rows = readEvents(root).filter((row) => row.idem_key === 'dup-key')
      assert.equal(rows.length, 1)
      assert.equal(rows[0].subject, 'ws-a', '首条裁决为准,后到同 key 不覆盖')
    })

    await check('idem 幂等:NULL idem_key 不参与去重(部分唯一索引 WHERE NOT NULL,多行共存)', async () => {
      const r = await eventsRequest(base, CLIENT, [
        { kind: 'workspace-open', subject: 'no-idem-1', payload_json: '{}' },
        { kind: 'workspace-open', subject: 'no-idem-2', payload_json: '{}' },
      ])
      assert.deepEqual(r.body, { ok: true, accepted: 2, rejected: 0 })
      assert.equal(readEvents(root).filter((row) => row.idem_key === null).length, 3, '两次上行共 3 行 NULL idem_key 共存')
    })

    /* ---------- ⑤ 超限 400 ---------- */

    await check(`超限 400:body > ${BRIDGE_EVENTS_BODY_LIMIT} 字节整批拒绝且零行落账(流中截断,不等 end)`, async () => {
      const rowsBefore = readEvents(root).length
      const oversized = JSON.stringify({
        clientId: CLIENT,
        events: [{ kind: 'workspace-open', subject: 'big', payload_json: 'a'.repeat(BRIDGE_EVENTS_BODY_LIMIT) }],
      })
      assert.ok(oversized.length > BRIDGE_EVENTS_BODY_LIMIT, '夹具自证:请求体确实超限')
      const r = await driveEventsRoute(mod, { authorization: 'Bearer events-key', origin: EXTENSION_ORIGIN, 'content-type': 'application/json' }, oversized)
      assert.equal(r.statusCode, 400)
      assert.ok(r.body.includes('上限'), `错误面须说明上限(实际:${r.body})`)
      assert.equal(readEvents(root).length, rowsBefore, '超限批次零行落账')
    })

    /* ---------- ⑥ 无账本形态 fail-closed ---------- */

    await check('无账本形态(缺 stateRoot 纯内存):503 fail-closed——事件无处落账,不假成功', async () => {
      const r = await eventsRequest(`http://127.0.0.1:${noLedgerHandle.port}`, CLIENT, [
        { kind: 'workspace-open', subject: 'ws-x', payload_json: '{}' },
      ])
      assert.equal(r.status, 503)
      assert.equal(r.body.ok, false)
      assert.ok(String(r.body.error).includes('fail-closed'))
    })
  } finally {
    if (handle!) await closeBackend(handle, [mod]).catch(() => { /* 已断则罢 */ })
    if (noKeyHandle!) await closeBackend(noKeyHandle, [noKeyMod]).catch(() => { /* 同上 */ })
    if (noLedgerHandle!) await closeBackend(noLedgerHandle, [noLedgerMod]).catch(() => { /* 同上 */ })
    rmSync(root, { recursive: true, force: true })
  }

  console.log(`\n§70 bridge events: ${passed} 段全绿`)
}

main().catch((e) => {
  console.error('FAIL:', e)
  process.exit(1)
})
