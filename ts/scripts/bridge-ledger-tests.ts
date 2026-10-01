/**
 * 桥作业账本测试(§69;批次 A「桥作业账本化」,2026-10-01)。
 *
 * 全离线确定性:隔离 stateRoot(mkdtemp)+ 临时端口回环桥 + 进程内假扩展客户端
 * (直 fetch 桥端点),零网络出站、零真实供应商、零真实凭据、不写共享状态。
 *
 * 覆盖(规格批次 A §7):
 *   ① 建表:三表落位 + 独立 db 文件(<stateRoot>/gotry-state/bridge.db,与
 *      state-ledger 的 gotry-state.db 物理分库)+ status CHECK 约束;
 *   ② write-before-submit:submit() 同步段内 queued 行已在账本(先写后派发),
 *      账本写失败 = 提交失败不入队(fail-closed);
 *   ③ 领取/回包/超时结算:claim 落 claimed+attempts;回包落 resolved+result;
 *      claimed 超时→unresolved+bridge_pacing 记冷却;从未领取超时→void;
 *   ④ 未知回包:404 {ok:false,error:'unknown-job'} + 孤儿内容落
 *      bridge_jobs(status='unresolved',result_json 保留);resolved 迟到回包不覆盖;
 *   ⑤ 恢复重排:queued 未过期→重排可领取 / queued 已过期→void /
 *      claimed 已超时→unresolved+pacing / claimed 未超时→复活(迟到回包直达 resolved);
 *   ⑥ bridge_clients upsert(轮询即刷新 origin/capabilities/last_seen)+
 *      cookie-names 命中记 login_sites(名字级,零凭据)+ 非导航作业不记节律;
 *   ⑦ 挂载路径接线:stateRoot → ledger-backed 队列 + 启动即 recoverOnBoot +
 *      检索前账本节律读判定(冷却内 429,冷却过期放行)。
 */

import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createServer } from 'node:http'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import Database from 'better-sqlite3'
import type { IncomingMessage, ServerResponse } from 'node:http'

import {
  EXTENSION_ORIGIN,
  createBridgeJobQueue,
  type BridgeJobQueue,
} from '../capabilities/session/extension-bridge.ts'
import {
  BRIDGE_SITE_COOLDOWN_MS,
  BridgeLedgerStore,
  bridgeLedgerDbPath,
  openBridgeLedgerStore,
} from '../capabilities/session/bridge-ledger.ts'
import { startSessionSearchModule } from '../src/backend/modules/session-search.ts'

let passed = 0
async function check(label: string, assertion: () => void | Promise<void>): Promise<void> {
  await assertion()
  passed += 1
  console.log(`  ok - ${label}`)
}

/** 回环桥测试面:临时端口 + close 时清连接(防 parked 长轮询钉住测试进程) */
async function serveQueue(queue: BridgeJobQueue): Promise<{ port: number; close: () => Promise<void> }> {
  const server = createServer((req, res) => queue.handleRequest(req, res))
  server.on('connection', (socket) => socket.unref())
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  server.unref()
  const port = (server.address() as { port: number }).port
  return {
    port,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.()
        server.close(() => resolve())
      }),
  }
}

interface FakeJob {
  jobId: string
  kind: string
  site: string
}

/** 假扩展轮询:POST /jobs(可信 Origin;带 clientId/capabilities 时同时驱动 bridge_clients upsert) */
async function pollJobs(port: number, opts: { clientId?: string; capabilities?: string[]; origin?: string } = {}): Promise<{ job: FakeJob | null }> {
  const r = await fetch(`http://127.0.0.1:${port}/jobs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: opts.origin ?? EXTENSION_ORIGIN },
    body: JSON.stringify({
      extensionVersion: 'bridge-ledger-tests',
      ...(opts.capabilities ? { capabilities: opts.capabilities } : {}),
      ...(opts.clientId ? { clientId: opts.clientId } : {}),
    }),
    signal: AbortSignal.timeout(3_000),
  })
  assert.equal(r.status, 200, `/jobs 轮询不得非 200(Origin=${opts.origin ?? EXTENSION_ORIGIN})`)
  return (await r.json()) as { job: FakeJob | null }
}

async function postResult(port: number, jobId: string, result: Record<string, unknown>, opts: { origin?: string; clientId?: string } = {}): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/results/${encodeURIComponent(jobId)}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: opts.origin ?? EXTENSION_ORIGIN,
      ...(opts.clientId ? { 'x-gotry-client-id': opts.clientId } : {}),
    },
    body: JSON.stringify(result),
  })
}

/** 等 /status 报 parked=N(先 park 再 submit,派发即时无竞态) */
async function waitForParked(port: number, expected: number, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const r = await fetch(`http://127.0.0.1:${port}/status`)
    if (((await r.json()) as { parked?: number }).parked === expected) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`/status 未在 ${timeoutMs}ms 内报告 parked=${expected}`)
}

async function main(): Promise<void> {
  console.log('§69 桥作业账本(bridge ledger,全离线)')

  /* ---------- ① 建表与分库独立性 ---------- */

  const rootA = mkdtempSync(join(tmpdir(), 'gotry-bridge-ledger-a-'))
  const storeA = openBridgeLedgerStore(rootA)
  await check('建表:bridge.db 落位 <stateRoot>/gotry-state/,三表齐备,与 state-ledger 的 gotry-state.db 物理分库', () => {
    assert.ok(existsSync(bridgeLedgerDbPath(rootA)), `db 文件应存在:${bridgeLedgerDbPath(rootA)}`)
    assert.equal(existsSync(join(rootA, 'gotry-state', 'gotry-state.db')), false, '不得触碰 state-ledger 的 gotry-state.db')
    const raw = new Database(bridgeLedgerDbPath(rootA), { readonly: true })
    try {
      const tables = (raw.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as Array<{ name: string }>).map((t) => t.name)
      for (const t of ['bridge_jobs', 'bridge_clients', 'bridge_pacing']) assert.ok(tables.includes(t), `缺表 ${t}`)
    } finally {
      raw.close()
    }
  })

  await check('建表:bridge_jobs.status CHECK 约束(闭集 queued|claimed|resolved|unresolved|void)', () => {
    const raw = new Database(bridgeLedgerDbPath(rootA))
    try {
      assert.throws(
        () => raw.prepare(`INSERT INTO bridge_jobs (id, kind, site, payload_json, status, created_at, updated_at) VALUES ('x', 'search', 's', '{}', 'bogus', 0, 0)`).run(),
        /CHECK/,
        '非法 status 必须被物理约束拒绝',
      )
    } finally {
      raw.close()
    }
  })

  /* ---------- ② write-before-submit 顺序 ---------- */

  const queueB = createBridgeJobQueue({ store: storeA })
  await check('write-before-submit:submit() 调用的同步段内 queued 行已落账(先写后派发)', async () => {
    const server = await serveQueue(queueB)
    try {
      // 不 await:同一同步段查账,证明 INSERT 先于任何派发/入队发生
      const pending = queueB.submit({ kind: 'search', site: 'dida-portal', url: 'https://portal.dida.com/find' }, { timeoutMs: 400, extensionWaitMs: 0 })
      const raw = new Database(bridgeLedgerDbPath(rootA), { readonly: true })
      let queued: Array<{ id: string; payload_json: string }> = []
      try {
        queued = raw.prepare(`SELECT id, payload_json FROM bridge_jobs WHERE status='queued'`).all() as Array<{ id: string; payload_json: string }>
      } finally {
        raw.close()
      }
      assert.equal(queued.length, 1, '入队前必须已有恰好一行 queued')
      assert.ok(queued[0].payload_json.includes('portal.dida.com'), 'payload_json 保留作业原文供恢复重放')
      const outcome = await pending
      assert.equal(outcome.ok, false)
      assert.equal(outcome.reason, 'extension-not-connected', '宽限 0ms 且扩展未连接 → no-spend 失败')
      assert.equal(storeA.getJob(queued[0].id)?.status, 'void', '从未被领取的失败终态 = void(零站点花费)')
    } finally {
      await server.close()
    }
  })

  await check('write-before-submit:账本写失败 = 提交失败不入队(fail-closed)', async () => {
    const broken = new BridgeLedgerStore(join(rootA, 'gotry-state', 'broken.db'))
    broken.close()
    const q = createBridgeJobQueue({ store: broken })
    try {
      const outcome = await q.submit({ kind: 'search', site: 'dida-portal', url: 'https://portal.dida.com/find' }, { timeoutMs: 300, extensionWaitMs: 0 })
      assert.equal(outcome.ok, false)
      assert.equal(outcome.reason, 'bridge-unavailable')
      assert.match(outcome.summary, /账本写入失败/, '失败摘要必须指向账本写入')
      assert.equal(q.stats().queued, 0, '未入队')
      assert.equal(q.stats().inFlight, 0, '未派发')
    } finally {
      await q.close()
    }
  })
  await queueB.close()
  storeA.close()
  rmSync(rootA, { recursive: true, force: true })

  /* ---------- ③ 领取/回包/超时结算 ---------- */

  const rootC = mkdtempSync(join(tmpdir(), 'gotry-bridge-ledger-c-'))
  const storeC = openBridgeLedgerStore(rootC)
  const queueC = createBridgeJobQueue({ store: storeC })
  const CLAIM_CLIENT = randomUUID()

  await check('领取与善果回包:claim 落 claimed+领取者+attempts+导航记节律;回包落 resolved+result;迟到回包不翻案', async () => {
    const server = await serveQueue(queueC)
    try {
      const pollPromise = pollJobs(server.port, { clientId: CLAIM_CLIENT, capabilities: ['dida-portal'] })
      await waitForParked(server.port, 1)
      const pending = queueC.submit({ kind: 'search', site: 'dida-portal', url: 'https://portal.dida.com/find' }, { timeoutMs: 3_000 })
      const polled = await pollPromise
      assert.ok(polled.job, 'parked 取活者应即时领走新作业')
      const row = storeC.getJob(polled.job!.jobId)
      assert.equal(row?.status, 'claimed')
      assert.equal(row?.claimed_origin, EXTENSION_ORIGIN)
      assert.equal(row?.claimed_by_client, CLAIM_CLIENT)
      assert.equal(row?.attempts, 1)
      assert.ok(row?.claimed_at !== null, 'claimed_at 落账')
      const pacing = storeC.pacingOf('dida-portal')
      assert.ok(pacing && pacing.cooldownUntil > Date.now(), '导航类作业领取即记节律冷却')
      // 正常善果回包 → resolved + result 保留
      const r = await postResult(server.port, polled.job!.jobId, { ok: true, kind: 'search', body: '{"rates":[]}', title: 'ok' }, { clientId: CLAIM_CLIENT })
      assert.equal(r.status, 200)
      const outcome = await pending
      assert.equal(outcome.ok, true)
      const settled = storeC.getJob(polled.job!.jobId)
      assert.equal(settled?.status, 'resolved')
      assert.ok(settled?.result_json?.includes('rates'), 'result_json 保留回包内容')
      // resolved 之后迟到重复回包:未知化 404,且不覆盖已决 resolved
      const late = await postResult(server.port, polled.job!.jobId, { ok: true, kind: 'search', body: 'LATE' }, { clientId: CLAIM_CLIENT })
      assert.equal(late.status, 404)
      assert.equal(storeC.getJob(polled.job!.jobId)?.status, 'resolved', '迟到回包不得翻案已决结果')
    } finally {
      await server.close()
    }
  })

  await check('超时结算:曾被领取 → unresolved + bridge_pacing 记冷却(该站点可能已被打)', async () => {
    const server = await serveQueue(queueC)
    try {
      const pollPromise = pollJobs(server.port)
      await waitForParked(server.port, 1)
      const pending = queueC.submit({ kind: 'search', site: 'train-12306', url: 'https://kyfw.12306.cn/otn/leftTicket/query' }, { timeoutMs: 400 })
      const polled = await pollPromise
      assert.ok(polled.job, '领取成功')
      const outcome = await pending
      assert.equal(outcome.ok, false)
      assert.equal(outcome.reason, 'timeout')
      const row = storeC.getJob(polled.job!.jobId)
      assert.equal(row?.status, 'unresolved', '曾被领取的超时终态 = unresolved')
      assert.ok(row?.result_json?.includes('timeout'), '超时结算留 timeout 备注')
      const pacing = storeC.pacingOf('train-12306')
      assert.ok(pacing && pacing.cooldownUntil >= Date.now() + BRIDGE_SITE_COOLDOWN_MS - 2_000, '超时结算把站点冷却推满')
    } finally {
      await server.close()
    }
  })

  await check('超时结算:从未被领取 → void,超时结算不追加冷却(提交时刻的节律按内存闸同语义保留)', async () => {
    const server = await serveQueue(queueC)
    try {
      const pending = queueC.submit({ kind: 'search', site: 'ctrip-hotel', url: 'https://hotels.ctrip.com/hotels/list' }, { timeoutMs: 300, extensionWaitMs: 30_000 })
      const pacingAtSubmit = storeC.pacingOf('ctrip-hotel')
      assert.ok(pacingAtSubmit && pacingAtSubmit.cooldownUntil > Date.now(), '导航类作业提交即记节律(与 sessionDidaSearch 内存闸同语义:提交即承诺一次导航)')
      const outcome = await pending
      assert.equal(outcome.ok, false)
      assert.equal(outcome.reason, 'timeout', '宽限放足,确保走到超时而非未连接')
      const raw = new Database(bridgeLedgerDbPath(rootC), { readonly: true })
      let voided: Array<{ id: string }> = []
      try {
        voided = raw.prepare(`SELECT id FROM bridge_jobs WHERE status='void' AND site='ctrip-hotel'`).all() as Array<{ id: string }>
      } finally {
        raw.close()
      }
      assert.equal(voided.length, 1, '未被领取的超时作业 = void')
      const pacingAfter = storeC.pacingOf('ctrip-hotel')
      assert.equal(pacingAfter?.cooldownUntil, pacingAtSubmit?.cooldownUntil, '从未被领取的超时结算不追加冷却(站点未被打)')
    } finally {
      await server.close()
    }
  })

  /* ---------- ④ 未知回包 404 + 孤儿落库 ---------- */

  await check('未知回包:404 {ok:false,error:"unknown-job"} + 孤儿内容落 bridge_jobs(unresolved+result 保留)', async () => {
    const server = await serveQueue(queueC)
    try {
      const r = await postResult(server.port, 'orphan-job-404', { ok: true, kind: 'search', body: 'ORPHAN-BODY-EVIDENCE', title: 'orphan' })
      assert.equal(r.status, 404, '未知 jobId 不再 200 静默丢弃')
      const body = (await r.json()) as { ok?: boolean; error?: string }
      assert.equal(body.ok, false)
      assert.equal(body.error, 'unknown-job')
      const row = storeC.getJob('orphan-job-404')
      assert.equal(row?.status, 'unresolved', '孤儿回包以 unresolved 落库供对账')
      assert.equal(row?.kind, 'search', 'kind 取回包自报')
      assert.ok(row?.result_json?.includes('ORPHAN-BODY-EVIDENCE'), '回包内容 result_json 原样保留')
    } finally {
      await server.close()
    }
  })

  /* ---------- ⑤ 恢复重排(recoverOnBoot) ---------- */

  await check('恢复重排:queued 未过期重排可领取 / queued 已过期 void / claimed 已超时 unresolved+pacing / claimed 未超时复活', async () => {
    const rootE = mkdtempSync(join(tmpdir(), 'gotry-bridge-ledger-e-'))
    const storeE = openBridgeLedgerStore(rootE)
    const t0 = Date.now()
    const LIVE_CLIENT = randomUUID()
    let q: BridgeJobQueue | undefined
    let server: { port: number; close: () => Promise<void> } | undefined
    try {
      // 直接落账模拟上一进程崩溃后的持久状态(不经过队列 close——close 会把未领取作业落 void)
      storeE.insertQueuedJob({ jobId: 'rec-queued-fresh', kind: 'search', site: 'dida-portal', url: 'https://portal.dida.com/find' }, t0 + 60_000)
      storeE.insertQueuedJob({ jobId: 'rec-queued-stale', kind: 'search', site: 'dida-portal', url: 'https://portal.dida.com/find' }, t0 - 1_000)
      storeE.insertQueuedJob({ jobId: 'rec-claimed-live', kind: 'search', site: 'ctrip-flight', url: 'https://flights.ctrip.com/online/list' }, t0 + 60_000)
      storeE.markClaimed('rec-claimed-live', { origin: EXTENSION_ORIGIN, clientId: LIVE_CLIENT })
      storeE.insertQueuedJob({ jobId: 'rec-claimed-dead', kind: 'search', site: 'ctrip-hotel', url: 'https://hotels.ctrip.com/hotels/list' }, t0 - 1_000)
      storeE.markClaimed('rec-claimed-dead', { origin: EXTENSION_ORIGIN })

      q = createBridgeJobQueue({ store: storeE })
      server = await serveQueue(q)
      // 恢复先于任何轮询执行(等价挂载路径:模块启动即 recoverOnBoot)
      const summary = q.recoverOnBoot!()
      assert.equal(summary.requeued, 1)
      assert.equal(summary.voidedStale, 1)
      assert.equal(summary.rehydratedInFlight, 1)
      assert.equal(summary.settledUnresolved, 1)
      assert.equal(storeE.getJob('rec-queued-stale')?.status, 'void', '未被领取即过期 → void,不再派发(零花费)')
      assert.equal(storeE.getJob('rec-claimed-dead')?.status, 'unresolved', '领取后超时 → unresolved')
      assert.ok(storeE.pacingOf('ctrip-hotel') && storeE.pacingOf('ctrip-hotel')!.cooldownUntil > Date.now(), '超时结算记节律冷却')
      // 重排作业可被新进程的扩展领取并善果落账
      const polled = await pollJobs(server.port, { clientId: LIVE_CLIENT, capabilities: ['dida-portal'] })
      assert.equal(polled.job?.jobId, 'rec-queued-fresh', '恢复的 queued 作业重排进队列')
      await postResult(server.port, 'rec-queued-fresh', { ok: true, kind: 'search', body: 'RECOVERED' }, { clientId: LIVE_CLIENT })
      assert.equal(storeE.getJob('rec-queued-fresh')?.status, 'resolved', '重排作业回包 → resolved(迟到善果不丢)')
      // 复活的 claimed 作业:扩展迟到回包直达 resolved(重启丢在飞作业缺陷的修复面)
      const late = await postResult(server.port, 'rec-claimed-live', { ok: true, kind: 'search', body: 'LATE-AFTER-RESTART' }, { clientId: LIVE_CLIENT })
      assert.equal(late.status, 200, '复活在飞作业对领取客户端放行')
      assert.equal(storeE.getJob('rec-claimed-live')?.status, 'resolved', '重启前领取的作业,重启后回包仍闭环')
    } finally {
      if (server) await server.close()
      if (q) await q.close()
      storeE.close()
      rmSync(rootE, { recursive: true, force: true })
    }
  })

  /* ---------- ⑥ bridge_clients upsert 与登录站点(名字级) ---------- */

  await check('bridge_clients upsert:轮询即刷新 origin/capabilities/last_seen;cookie-names 命中记 login_sites;非导航作业不记节律', async () => {
    const server = await serveQueue(queueC)
    try {
      const CLIENT = randomUUID()
      const pacingBefore = storeC.pacingOf('dida-portal')
      const first = queueC.submit({ kind: 'cookie-names', site: 'dida-portal', timeoutMs: 3_000 }, { timeoutMs: 3_000 })
      const polled = await pollJobs(server.port, { clientId: CLIENT, capabilities: ['dida-portal'] })
      assert.ok(polled.job, 'cookie-names 作业应被领取')
      await postResult(server.port, polled.job!.jobId, { ok: true, kind: 'cookie-names', names: ['dida_session_sig'] }, { clientId: CLIENT })
      assert.equal((await first).ok, true)
      const row1 = storeC.getClient(CLIENT)
      assert.ok(row1, '轮询即注册客户端')
      assert.equal(row1?.origin, EXTENSION_ORIGIN)
      assert.deepEqual(JSON.parse(row1?.capabilities_json ?? '[]'), ['dida-portal'])
      assert.deepEqual(JSON.parse(row1?.login_sites_json ?? '[]'), ['dida-portal'], 'cookie-names 命中票据名 → login_sites(名字级)')
      const seen1 = row1?.last_seen_at ?? 0
      // upsert 二次:能力清单变化 + last_seen 刷新,login_sites 不丢
      const second = queueC.submit({ kind: 'cookie-names', site: 'dida-portal', timeoutMs: 3_000 }, { timeoutMs: 3_000 })
      const polled2 = await pollJobs(server.port, { clientId: CLIENT, capabilities: ['dida-portal', 'train-12306'] })
      assert.ok(polled2.job, '第二次轮询仍可领取')
      await postResult(server.port, polled2.job!.jobId, { ok: true, kind: 'cookie-names', names: [] }, { clientId: CLIENT })
      assert.equal((await second).ok, true)
      const row2 = storeC.getClient(CLIENT)
      assert.deepEqual(JSON.parse(row2?.capabilities_json ?? '[]'), ['dida-portal', 'train-12306'], 'upsert 覆盖能力清单')
      assert.ok((row2?.last_seen_at ?? 0) >= seen1, 'last_seen_at 单调刷新')
      assert.deepEqual(JSON.parse(row2?.login_sites_json ?? '[]'), ['dida-portal'], 'upsert 不回退 login_sites')
      const pacingAfter = storeC.pacingOf('dida-portal')
      assert.deepEqual(pacingAfter, pacingBefore, 'cookie-names 非导航作业,不推动节律')
    } finally {
      await server.close()
    }
  })
  await queueC.close()
  storeC.close()
  rmSync(rootC, { recursive: true, force: true })

  /* ---------- ⑦ 挂载路径模块接线(stateRoot → ledger-backed + recoverOnBoot + 节律读判定) ---------- */

  await check('挂载路径:stateRoot → ledger-backed 队列 + 启动即 recoverOnBoot + 账本冷却内 429/冷却过期放行', async () => {
    const rootG = mkdtempSync(join(tmpdir(), 'gotry-bridge-ledger-g-'))
    try {
      // 预置一条上一进程遗留的已超时 claimed 作业:模块启动即应结算 unresolved
      const seed = openBridgeLedgerStore(rootG)
      seed.insertQueuedJob({ jobId: 'mount-recover-dead', kind: 'search', site: 'dida-portal', url: 'https://portal.dida.com/find' }, Date.now() - 1_000)
      seed.markClaimed('mount-recover-dead', { origin: EXTENSION_ORIGIN })
      seed.close()

      const mod = startSessionSearchModule({
        apiKey: () => 'ledger-test-key',
        stateRoot: rootG,
        search: async () => ({
          ok: true, via: 'session-dida-portal', evidence: '[会话:dida-portal@ledger-test]', latencyMs: 1, verdict: 'hit', rates: [],
        }),
      })
      try {
        assert.ok(existsSync(bridgeLedgerDbPath(rootG)), '挂载路径模块创建即落 bridge.db')
        const probe = openBridgeLedgerStore(rootG)
        try {
          // recoverOnBoot 已在模块启动路径跑过:遗留 claimed 超时作业被结算
          assert.equal(probe.getJob('mount-recover-dead')?.status, 'unresolved', '启动即恢复结算遗留超时作业')
          // 账本节律读判定:冷却内 429(带 retry-after)
          probe.applyCooldown('dida-portal')
          const hot = await driveModuleSearch(mod, 'Bearer ledger-test-key')
          assert.equal(hot.statusCode, 429, '账本冷却内检索被节律闸拒绝')
          assert.ok(String(hot.headers['retry-after'] ?? '').length > 0, '429 携带 retry-after')
          assert.ok(hot.body.includes('cooldown'), '错误面说明冷却来源')
          // 冷却过期 → 放行(fake search 命中 200)
          const raw = new Database(bridgeLedgerDbPath(rootG))
          try {
            raw.prepare(`UPDATE bridge_pacing SET cooldown_until=? WHERE site='dida-portal'`).run(Date.now() - 1_000)
          } finally {
            raw.close()
          }
          const cool = await driveModuleSearch(mod, 'Bearer ledger-test-key')
          assert.equal(cool.statusCode, 200, '冷却过期后放行')
          assert.ok(cool.body.includes('"verdict":"hit"'), '注入的 fake 检索结果透传')
        } finally {
          probe.close()
        }
      } finally {
        await mod.close?.()
      }
    } finally {
      rmSync(rootG, { recursive: true, force: true })
    }
  })

  console.log(`\n§69 bridge ledger: ${passed} 段全绿`)
}

/** 模块路由直驱:假请求/响应(handle 同步注册 data/end 监听后再投喂 body) */
async function driveModuleSearch(mod: { routes: Array<{ method: string; path: string; handle: (req: IncomingMessage, res: ServerResponse) => void }> }, auth: string): Promise<{ statusCode: number; body: string; headers: Record<string, string | number | string[]> }> {
  const req = new EventEmitter() as unknown as IncomingMessage
  Object.assign(req as unknown as Record<string, unknown>, { method: 'POST', url: '/v1/session/search', headers: { authorization: auth, 'content-type': 'application/json' } })
  const headers: Record<string, string | number | string[]> = {}
  let settle!: (v: { statusCode: number; body: string; headers: Record<string, string | number | string[]> }) => void
  const done = new Promise<{ statusCode: number; body: string; headers: Record<string, string | number | string[]> }>((resolve) => { settle = resolve })
  let statusCode = 200
  const res = {
    get statusCode(): number { return statusCode },
    set statusCode(v: number) { statusCode = v },
    setHeader: (k: string, v: string | number | readonly string[]): void => { headers[k.toLowerCase()] = v as string | number | string[] },
    end: (chunk?: unknown): void => { settle({ statusCode, body: typeof chunk === 'string' ? chunk : '', headers }) },
  }
  const route = mod.routes.find((r) => r.method === 'POST' && r.path === '/v1/session/search')
  if (!route) throw new Error('session-search 模块应注册 POST /v1/session/search')
  route.handle(req, res as unknown as ServerResponse)
  req.emit('data', Buffer.from('{"supplier":"dida-portal"}'))
  req.emit('end')
  return done
}

main().catch((e) => {
  console.error('FAIL:', e)
  process.exit(1)
})
