/**
 * 扩展传输车道合同测试(§38;RFC §2.2 通道 C,2026-08-29 PRIMARY)。
 *
 * 全离线确定性:临时端口桥 + 进程内假扩展客户端(直 fetch 桥端点),不开浏览器、
 * 不碰登录态、不写共享状态(审计走 mkdtemp 隔离)。唯一慢例 = needs-extension 全链
 * (等扩展连接宽限 ~6s——这正是「零花费 no-spend」语义本身)。
 *
 * 三类断言:
 *   ① 合同面:manifest(MV3/key→固定 ID 派生/host_permissions 精确面/双 world content_scripts)
 *      与 Node 常量防漂移(BRIDGE_PORTS/LOGIN_COOKIE_NAMES/NETWORK_HINTS/flights.ctrip.com);
 *   ② 桥行为:origin 白名单(邪恶源 403)/ 长轮询取活幂等 / 心跳判定 / 提交-回包闭环 /
 *      超时与扩展未连接(有界等待 no-spend)/ close 结算;
 *   ③ 车道语义:classifyBridgeFailure(只有 extension-not-connected 是用户门)/
 *      resolveTransportMode(扩展默认,cdp 显式 opt-in)/ 审计 JSONL /
 *      needs-extension 全链 + waiting_extension 双源合同(no_spend_waiting_user)。
 */

import assert from 'node:assert/strict'
import { fork } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  BRIDGE_PORTS,
  EXTENSION_ID,
  EXTENSION_ID_STORE,
  EXTENSION_ORIGIN,
  EXTENSION_ORIGIN_STORE,
  EXTENSION_ORIGINS,
  EXTENSION_STORE_URL,
  createSessionBridge,
  __resetSessionBridgeForTest,
  __setSessionBridgeForTest,
  type SessionJobHandle,
} from '../capabilities/session/extension-bridge.ts'
import {
  classifyBridgeFailure,
  extensionCookieNames,
  extensionSearchJob,
} from '../capabilities/session/extension-channel.ts'
import { appendExtensionAudit, resolveTransportMode, sessionFlightSearch, sessionHotelSearch, sessionTrainSearch, __resetRateLimiterForTest } from '../capabilities/session-search.ts'
import { sessionLogin } from '../capabilities/session-login.ts'
import { LOGIN_COOKIE_NAMES, NETWORK_HINTS, SITE_DOMAIN } from '../capabilities/session/adapters/ctrip-flight.ts'
import { HOTEL_NETWORK_HINTS, HOTEL_SITE_HOST, buildHotelEntryUrl } from '../capabilities/session/adapters/ctrip-hotel.ts'
import { TRAIN_NETWORK_HINTS, TRAIN_SITE_HOST } from '../capabilities/session/adapters/rail-12306.ts'
import { evaluateDoubleSource, type SessionComparableRecord } from '../capabilities/session/benchmark.ts'

const EXT_DIR = fileURLToPath(new URL('../../extension/', import.meta.url))
const UNREF_CHILD = fileURLToPath(new URL('./fixtures/extension-bridge-unref-child.mjs', import.meta.url))
const read = (f: string): string => readFileSync(join(EXT_DIR, f), 'utf8')

let passed = 0
async function check(label: string, assertion: () => void | Promise<void>): Promise<void> {
  await assertion()
  passed += 1
  console.log(`  ok - ${label}`)
}

const mustBridge = async (ports: number[]): Promise<SessionJobHandle> => {
  // 缺省 EXTENSION_ORIGINS(unpacked + 商店版双通道)——行为测试直接覆盖生产默认白名单
  const created = await createSessionBridge({ ports })
  if (!created.ok) throw new Error(created.summary)
  return created.bridge
}

interface FakeJob {
  jobId: string
  kind: string
  site?: string
  url?: string
  timeoutMs?: number
}

/** 假扩展客户端:一次长轮询取活 + 回包(Origin=固定扩展源,过桥白名单) */
async function claimOnce(port: number, respond: ((job: FakeJob) => Record<string, unknown> | null) | null, signal?: AbortSignal): Promise<{ job: FakeJob | null }> {
  const r = await fetch(`http://127.0.0.1:${port}/jobs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: EXTENSION_ORIGIN },
    body: JSON.stringify({ extensionVersion: 'test' }),
    signal,
  })
  const data = (await r.json()) as { job: FakeJob | null }
  if (data.job && respond) {
    const result = respond(data.job)
    if (result) {
      await fetch(`http://127.0.0.1:${port}/results/${encodeURIComponent(data.job.jobId)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: EXTENSION_ORIGIN },
        body: JSON.stringify(result),
      })
    }
  }
  return data
}

async function heartbeat(port: number): Promise<void> {
  // 带扩展 Origin(与浏览器扩展 SW fetch 同形;无 Origin 的 /health 只是诊断,不记心跳)
  await fetch(`http://127.0.0.1:${port}/health`, { headers: { origin: EXTENSION_ORIGIN } })
}

async function waitForParkedCount(port: number, expected: number, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const r = await fetch(`http://127.0.0.1:${port}/status`)
    const body = (await r.json()) as { parked?: number }
    if (body.parked === expected) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`/status 未在 ${timeoutMs}ms 内报告 parked=${expected}`)
}

async function assertParkedClientDoesNotPinHost(): Promise<void> {
  const child = fork(UNREF_CHILD, [], {
    execArgv: process.execArgv,
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  })
  let stderr = ''
  child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8') })
  let parkedRequest: Promise<{ job: FakeJob | null }> | null = null
  try {
    const port = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('子进程扩展桥未在 2s 内监听')), 2_000)
      child.once('message', (message: unknown) => {
        clearTimeout(timer)
        const data = message as { kind?: string; port?: number; summary?: string }
        if (data.kind === 'listening' && typeof data.port === 'number') resolve(data.port)
        else reject(new Error(data.summary ?? `子进程消息异常:${JSON.stringify(data)}`))
      })
      child.once('exit', (code, signal) => {
        clearTimeout(timer)
        reject(new Error(`子进程过早退出 code=${code} signal=${signal} ${stderr}`))
      })
    })

    parkedRequest = claimOnce(port, null).catch(() => ({ job: null }))
    await waitForParkedCount(port, 1)

    const exitP = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill()
        reject(new Error('默认桥被 parked /jobs 长轮询钉住超过 1500ms'))
      }, 1_500)
      child.once('exit', (code, signal) => {
        clearTimeout(timer)
        resolve({ code, signal })
      })
    })
    child.send({ kind: 'release' })
    const exited = await exitP
    assert.equal(exited.code, 0, `子进程应自然退出:${stderr}`)
    assert.equal(exited.signal, null)
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill()
    if (parkedRequest) await parkedRequest
  }
}

const stripRe = (s: string): string => s.replace(/\\/g, '')

async function main(): Promise<void> {
  console.log('§38 扩展传输车道合同(extension bridge,全离线)')

  /* ---------- ① manifest 合同与防漂移 ---------- */

  const manifest = JSON.parse(read('manifest.json')) as {
    manifest_version: number
    permissions: string[]
    host_permissions: string[]
    content_scripts: Array<{ matches: string[]; js: string[]; world?: string; run_at?: string }>
    key: string
    version: string
  }

  const derivedId = createHash('sha256')
    .update(Buffer.from(manifest.key, 'base64'))
    .digest()
    .subarray(0, 16)
    .toString('hex')
    .replace(/[0-9a-f]/g, (c) => 'abcdefghijklmnop'[Number.parseInt(c, 16)])
  await check('manifest key 派生扩展 ID = Node 侧固定 EXTENSION_ID(unpacked 通道 origin 白名单锚点)', () => {
    assert.equal(derivedId, EXTENSION_ID)
    assert.equal(EXTENSION_ORIGIN, `chrome-extension://${EXTENSION_ID}`)
  })

  await check('双通道白名单:商店版 ID(CWS 重签,不认 manifest key)与 unpacked 固定 ID 同信,商店 URL 锚定 item ID', () => {
    assert.equal(EXTENSION_ORIGIN_STORE, `chrome-extension://${EXTENSION_ID_STORE}`)
    assert.ok(EXTENSION_ORIGINS.includes(EXTENSION_ORIGIN))
    assert.ok(EXTENSION_ORIGINS.includes(EXTENSION_ORIGIN_STORE))
    assert.equal(EXTENSION_ORIGINS.length, 2)
    assert.ok(EXTENSION_STORE_URL.includes(EXTENSION_ID_STORE))
  })

  await check('manifest 合同:MV3 + 最小权限(cookies/alarms;无 debugger/tabs)', () => {
    assert.equal(manifest.manifest_version, 3)
    assert.deepEqual([...manifest.permissions].sort(), ['alarms', 'cookies'])
  })

  const manifestPorts = manifest.host_permissions
    .map((p) => /127\.0\.0\.1:(\d+)/.exec(p)?.[1])
    .filter((v): v is string => v != null)
    .map(Number)
    .sort((a, b) => a - b)
  await check('防漂移:桥端口池(Node BRIDGE_PORTS)= manifest host_permissions 回环面(+ ctrip 星域)', () => {
    assert.deepEqual(manifestPorts, [...BRIDGE_PORTS].sort((a, b) => a - b))
    assert.ok(manifest.host_permissions.includes('https://*.ctrip.com/*'))
  })

  await check('防漂移:content_scripts 双 world 挂 ctrip 双站+12306(MAIN 嗅探 + ISOLATED 桥;2026-09-03 酒/火实装)', () => {
    assert.equal(manifest.content_scripts.length, 2)
    for (const cs of manifest.content_scripts) {
      assert.deepEqual(cs.matches, ['https://flights.ctrip.com/*', `https://${HOTEL_SITE_HOST}/*`, `https://${TRAIN_SITE_HOST}/*`, 'https://www.12306.cn/*'])
      assert.equal(cs.run_at, 'document_start')
    }
    const worlds = manifest.content_scripts.map((cs) => cs.world ?? 'ISOLATED').sort()
    assert.deepEqual(worlds, ['ISOLATED', 'MAIN'])
    assert.deepEqual(manifest.content_scripts.map((cs) => cs.js[0]).sort(), ['content-bridge.js', 'content-main.js'])
  })

  const backgroundJs = read('background.js')
  const contentMainJs = read('content-main.js')
  const contentBridgeJs = read('content-bridge.js')
  await check('防漂移:票据 cookie 名单(Node LOGIN_COOKIE_NAMES)= 扩展 SITES.ticketNames', () => {
    for (const name of LOGIN_COOKIE_NAMES) {
      assert.ok(backgroundJs.includes(`'${name}'`), `background.js 缺票据名 ${name}`)
    }
    assert.ok(backgroundJs.includes("domain: 'ctrip.com'"), 'background.js 站点域应与 LOGIN_TARGETS.domain 对账')
  })
  await check('防漂移:NETWORK_HINTS + HOTEL_NETWORK_HINTS(Node)= content-main 嗅探面(MAIN-world)', () => {
    for (const hint of NETWORK_HINTS) {
      assert.ok(stripRe(contentMainJs).includes(stripRe(hint.source)), `content-main.js 缺 hint ${hint.source}`)
    }
    for (const hint of HOTEL_NETWORK_HINTS) {
      assert.ok(stripRe(contentMainJs).includes(stripRe(hint.source)), `content-main.js 缺酒店 hint ${hint.source}`)
    }
    for (const hint of TRAIN_NETWORK_HINTS) {
      assert.ok(stripRe(contentMainJs).includes(stripRe(hint.source)), `content-main.js 缺火车 hint ${hint.source}`)
    }
    assert.ok(contentMainJs.includes('12306'), 'content-main.js 应感知 12306 页域(火车嗅探作用域)')
    assert.ok(contentMainJs.includes('hotels\\.ctrip\\.com'), 'content-main.js 应感知酒店页域(形状嗅探兜底的作用域)')
  })
  await check('防漂移:酒店形状签名(Node looksLikeHotelListBody 同款)= content-main HOTEL_BODY_SIG_RE', () => {
    assert.ok(stripRe(contentMainJs).includes('"hotelList"|"hotelMatchInfos"|"hotelName"'), '形状嗅探签名两侧必须逐字一致')
  })
  await check('防漂移:检索/登录 URL 面(background per-site 白名单 flights+hotels;ISOLATED 桥转发两类事件)', () => {
    assert.ok(backgroundJs.includes('https://flights.ctrip.com/'), 'background 应含机票检索白名单')
    assert.ok(backgroundJs.includes(`https://${HOTEL_SITE_HOST}/`), 'background 应含酒店检索白名单(2026-09-03 实装)')
    assert.ok(backgroundJs.includes('https://kyfw.12306.cn/'), 'background 应含火车检索白名单(2026-09-03 实装)')
    assert.ok(backgroundJs.includes("'ctrip-hotel'"), 'background SITES 应注册 ctrip-hotel')
    assert.ok(backgroundJs.includes("'train-12306'"), 'background SITES 应注册 train-12306')
    assert.ok(contentMainJs.includes('gotry-ctrip-sniff'))
    assert.ok(contentBridgeJs.includes('gotry-ctrip-sniff'))
    assert.ok(contentBridgeJs.includes('gotry-page'))
  })
  await check('物理只读形态:扩展全部 fetch 只指向桥回环端口;不用 chrome.debugger', () => {
    for (const [name, src] of [['background', backgroundJs], ['content-main', contentMainJs], ['content-bridge', contentBridgeJs]] as const) {
      const loopbackFetches = src.match(/fetch\(`?http:\/\/127\.0\.0\.1/g) ?? []
      const allFetches = src.match(/fetch\(/g) ?? []
      assert.equal(loopbackFetches.length, allFetches.length, `${name}: fetch 必须只指向桥回环端口(扩展零写行为的代码面证据)`)
    }
    assert.ok(!backgroundJs.includes('chrome.debugger'), '扩展不得使用 chrome.debugger(警告条/调试面)')
  })

  /* ---------- ② 桥行为(临时端口 + 假扩展客户端) ---------- */

  const b = await mustBridge([0])
  const port = b.port

  await check('桥只绑回环临时端口;/health 无 Origin 可诊断', async () => {
    assert.ok(port > 0)
    const r = await fetch(`http://127.0.0.1:${port}/health`)
    const body = (await r.json()) as { ok: boolean; service: string }
    assert.equal(r.status, 200)
    assert.equal(body.ok, true)
    assert.equal(body.service, 'gotry-session-bridge')
  })

  await check('默认桥:parked 扩展长轮询不得钉住宿主 CLI 进程', assertParkedClientDoesNotPinHost)

  await check('origin 白名单:邪恶源(网页跨域必带)POST /jobs 与 /results 一律 403', async () => {
    for (const path of ['/jobs', '/results/whatever']) {
      const r = await fetch(`http://127.0.0.1:${port}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
        body: '{}',
      })
      assert.equal(r.status, 403, path)
    }
  })

  await check('origin 白名单:商店版扩展源(CWS 重签 ID,2026-09-02 上架)POST 放行且计入心跳', async () => {
    const storeLane = await mustBridge([0])
    try {
      assert.equal(storeLane.extensionConnected(), false)
      const r = await fetch(`http://127.0.0.1:${storeLane.port}/results/whatever`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: EXTENSION_ORIGIN_STORE },
        body: '{}',
      })
      assert.equal(r.status, 200, '商店版扩展源不得吃 403(否则商店通道全断)')
      assert.equal(storeLane.extensionConnected(), true, '白名单源的任何请求都刷新心跳')
    } finally {
      await storeLane.close()
    }
  })

  await check('心跳判定:初始未连接;合法请求(health/长轮询)后视为在线', async () => {
    assert.equal(b.extensionConnected(), false)
    await heartbeat(port)
    assert.equal(b.extensionConnected(), true)
  })

  await check('提交-回包闭环:cookie-names job 由假扩展取活并回包,submit 原样收果', async () => {
    const submitP = b.submit({ kind: 'cookie-names', site: 'ctrip-flight', timeoutMs: 5_000 }, { timeoutMs: 5_000 })
    const claimed = await claimOnce(port, (job) => {
      assert.equal(job.kind, 'cookie-names')
      assert.equal(job.site, 'ctrip-flight')
      return { ok: true, kind: 'cookie-names', names: ['cticket', 'uid'] }
    })
    assert.ok(claimed.job)
    const outcome = await submitP
    assert.ok(outcome.ok)
    assert.deepEqual(outcome.ok ? outcome.result.names : [], ['cticket', 'uid'])
  })

  await check('cookie 红线:扩展代码只上报名(c.name 映射),值不进任何结果对象', () => {
    assert.ok(backgroundJs.includes('.map((c) => c.name)'))
    assert.ok(!/\.value/.test(backgroundJs), 'background.js 不得触碰 cookie.value')
  })

  await check('长轮询幂等:并发取活只有一个客户端领到 job;后到者空手(快速中止,不挂进程)', async () => {
    const firstAc = new AbortController()
    const secondAc = new AbortController()
    const firstP = claimOnce(
      port,
      () => ({ ok: true, kind: 'cookie-names', names: ['cticket'] }),
      firstAc.signal,
    ).catch(() => ({ job: null }))
    let secondP: Promise<{ job: FakeJob | null }> | null = null
    try {
      await waitForParkedCount(port, 1)
      secondP = claimOnce(port, null, secondAc.signal).catch(() => ({ job: null }))
      await waitForParkedCount(port, 2)

      const submitP = b.submit({ kind: 'cookie-names', site: 'ctrip-flight', timeoutMs: 5_000 }, { timeoutMs: 5_000 })
      const first = await firstP
      assert.ok(first.job, '先进入 parked 队列的取活者必须领到 job')
      const outcome = await submitP
      assert.ok(outcome.ok)
    } finally {
      firstAc.abort()
      secondAc.abort()
      if (secondP) await secondP
    }
  })

  await check('超时语义:扩展在线但不回包 → timeout(降级 error,不伪装成功)', async () => {
    const outcome = await b.submit(
      { kind: 'search', site: 'ctrip-flight', url: 'https://flights.ctrip.com/online/list/oneway-sha-ljg?depdate=2026-12-01', timeoutMs: 300 },
      { timeoutMs: 300 },
    )
    assert.ok(!outcome.ok)
    assert.equal(outcome.ok ? null : outcome.reason, 'timeout')
  })

  await check('扩展未连接:有界等待后 extension-not-connected(用户门 no-spend,不空耗)', async () => {
    const fresh = await mustBridge([0])
    try {
      const outcome = await fresh.submit({ kind: 'cookie-names', site: 'ctrip-flight' }, { extensionWaitMs: 400, timeoutMs: 2_000 })
      assert.ok(!outcome.ok)
      assert.equal(outcome.ok ? null : outcome.reason, 'extension-not-connected')
    } finally {
      await fresh.close()
    }
  })

  await check('close:桥关闭后排队任务以 bridge-unavailable 结算(零花费)', async () => {
    const tmp = await mustBridge([0])
    await heartbeat(tmp.port)
    const submitP = tmp.submit({ kind: 'cookie-names', site: 'ctrip-flight', timeoutMs: 30_000 }, { timeoutMs: 30_000 })
    await tmp.close()
    const outcome = await submitP
    assert.ok(!outcome.ok)
    assert.equal(outcome.ok ? null : outcome.reason, 'bridge-unavailable')
  })

  /* ---------- ③ 车道语义 ---------- */

  await check('classifyBridgeFailure:只有 extension-not-connected 是用户门(needs-extension),其余 error', () => {
    assert.equal(classifyBridgeFailure('extension-not-connected'), 'needs-extension')
    assert.equal(classifyBridgeFailure('bridge-unavailable'), 'error')
    assert.equal(classifyBridgeFailure('timeout'), 'error')
    assert.equal(classifyBridgeFailure('job-error'), 'error')
  })

  const savedTransportEnv = process.env.GOTRY_SESSION_TRANSPORT
  const restoreTransportEnv = (): void => {
    if (savedTransportEnv === undefined) delete process.env.GOTRY_SESSION_TRANSPORT
    else process.env.GOTRY_SESSION_TRANSPORT = savedTransportEnv
  }
  try {
    delete process.env.GOTRY_SESSION_TRANSPORT
    await check('resolveTransportMode:扩展默认;cdp 须显式 opt-in;profileDir=persistent(测试)', () => {
      assert.equal(resolveTransportMode(), 'extension')
      process.env.GOTRY_SESSION_TRANSPORT = 'cdp'
      assert.equal(resolveTransportMode(), 'cdp')
      assert.equal(resolveTransportMode('/tmp/isolated-profile'), 'persistent')
    })
  } finally {
    restoreTransportEnv()
  }

  const auditDir = mkdtempSync(join(tmpdir(), 'gotry-ext-audit-'))
  const auditPath = join(auditDir, 'session-incidents.jsonl')
  appendExtensionAudit(auditPath, { kind: 'extension-session-job', site: 'ctrip-flight', url: 'https://flights.ctrip.com/online/list/oneway-sha-ljg?depdate=2026-12-01', jobId: 'search', result: 'body 1024B' })
  await check('审计:扩展 job 落 session-incidents 同款 JSONL(kind 区分,url 截断)', () => {
    const lines = readFileSync(auditPath, 'utf8').trim().split('\n')
    assert.equal(lines.length, 1)
    const entry = JSON.parse(lines[0]!) as { kind: string; site: string; url: string }
    assert.equal(entry.kind, 'extension-session-job')
    assert.equal(entry.site, 'ctrip-flight')
    assert.ok(entry.url.length <= 400)
  })
  rmSync(auditDir, { recursive: true, force: true })

  await check('车道闭环(注入临时桥+假扩展):cookie-names 只吐名字;search job 回传正文;登录快路径零交互', async () => {
    const lane = await mustBridge([0])
    __setSessionBridgeForTest(lane)
    try {
      let done = false
      const claimLoop = (async () => {
        while (!done) {
          const ac = new AbortController()
          const bail = setTimeout(() => ac.abort(), 2_000)
          try {
            await claimOnce(lane.port, (job) => {
              if (job.kind === 'cookie-names') return { ok: true, kind: 'cookie-names', names: ['cticket'] }
              if (job.kind === 'search') {
                const u = String(job.url)
                const isHotel = u.startsWith(`https://${HOTEL_SITE_HOST}/`)
                const isTrain = u.startsWith('https://kyfw.12306.cn/')
                assert.ok(u.startsWith('https://flights.ctrip.com/') || isHotel || isTrain, `search job 只允许已注册站点域,实际 ${u}`)
                return {
                  ok: true,
                  kind: 'search',
                  body: isHotel
                    ? JSON.stringify({ data: { hotelList: [{ hotelId: 442516, hotelName: 'Hotel X', star: 5, commentScore: 4.7, priceInfo: { avgPrice: 680 } }] } })
                    : isTrain
                      ? JSON.stringify({ data: { result: ['|预订|24000000G1375|G1375|SHH|KMM|SHH|KMM|07:35|15:27|07:52|Y|||||上海南|昆明|0|||有|有|--|有|--|--|有|--|--|有|'], map: {} } })
                      : JSON.stringify({ data: { flightItineraryList: [] } }),
                  title: isHotel ? '酒店列表' : isTrain ? '12306 车票预订' : '机票列表',
                }
              }
              return { ok: false, error: `unexpected kind ${job.kind}` }
            }, ac.signal)
          } catch { /* park 被中止=常态 */ }
          clearTimeout(bail)
        }
      })()

      const cookies = await extensionCookieNames({ site: 'ctrip-flight', domain: SITE_DOMAIN.replace(/^\./, ''), ticketNames: LOGIN_COOKIE_NAMES })
      assert.ok(cookies.ok)
      assert.deepEqual(cookies.ok ? cookies.tickets : [], ['cticket'])

      const search = await extensionSearchJob({ site: 'ctrip-flight', url: 'https://flights.ctrip.com/online/list/oneway-sha-ljg?depdate=2026-12-01', timeoutMs: 3_000 })
      assert.ok(search.ok)
      assert.equal(search.ok ? search.timedOut : true, false)
      assert.ok(search.ok ? search.body.includes('flightItineraryList') : false)

      // 酒店车道(2026-09-03 实装):per-site 白名单放行 hotels.ctrip.com,嗅探回包走形解析出结构化酒店
      const hotelLane = await extensionSearchJob({ site: 'ctrip-hotel', url: `https://${HOTEL_SITE_HOST}/hotels/list?city=220&checkin=2026-12-01&checkout=2026-12-03`, timeoutMs: 3_000 })
      assert.ok(hotelLane.ok, '酒店 search job 应放行(per-site 白名单)')
      assert.ok(hotelLane.ok ? hotelLane.body.includes('hotelList') : false)
      __resetRateLimiterForTest()
      const hotelSession = await sessionHotelSearch({ to: '迪拜', cityId: 220, checkIn: '2026-12-01', checkOut: '2026-12-03', timeoutMs: 3_000 })
      assert.equal(hotelSession.verdict, 'hit', `酒店会话检索应 hit,实际 ${hotelSession.verdict}:${hotelSession.error ?? ''}`)
      assert.ok(hotelSession.evidence.includes('[会话:ctrip-hotel@'), '酒店证据链 [会话:ctrip-hotel@ts]')
      assert.equal(hotelSession.hotels?.[0]?.name, 'Hotel X')
      assert.equal(hotelSession.hotels?.[0]?.price, 680)
      assert.ok(hotelSession.hotels?.[0]?.jumpUrl?.includes('/hotel/442516'), 'jumpUrl 由 hotelId 构造(预订由人在落地页完成)')

      // 火车车道(2026-09-03 实装):公开查询面无登录闸,per-site 白名单放行 kyfw,管道行解析出结构化车次
      __resetRateLimiterForTest()
      const trainSession = await sessionTrainSearch({ from: '上海', to: '昆明', date: '2026-12-01', timeoutMs: 3_000 })
      assert.equal(trainSession.verdict, 'hit', `火车会话检索应 hit,实际 ${trainSession.verdict}:${trainSession.error ?? ''}`)
      assert.ok(trainSession.evidence.includes('[会话:train-12306@'), '火车证据链 [会话:train-12306@ts]')
      assert.ok(trainSession.evidence.includes('公开查询面'), '证据链标注公开查询面(无登录闸的诚实口径)')
      assert.equal(trainSession.trains?.[0]?.trainCode, 'G1375')
      assert.equal(trainSession.trains?.[0]?.depTime, '07:35')
      assert.equal(trainSession.trains?.[0]?.durationMin, 472)
      assert.ok(trainSession.trains?.[0]?.jumpUrl?.includes('kyfw.12306.cn'), 'jumpUrl=查询落地页(人选车完成预订)')

      const login = await sessionLogin({ site: 'ctrip-flight' })
      assert.equal(login.verdict, 'logged-in')
      assert.deepEqual(login.tickets, ['cticket'])
      assert.ok(login.evidence.includes('自动检测'))

      done = true
      await claimLoop
    } finally {
      await __resetSessionBridgeForTest()
      __setSessionBridgeForTest(null)
      await lane.close()
    }
  })

  await check('全链 fail-closed:扩展车道桥端口池全占 → sessionFlightSearch verdict=error(环境故障,非用户门)', async () => {
    // 设计契约:只有 extension-not-connected 才是 user gate (needs-extension);
    // 端口池全占是环境故障(并行 gotry 实例/外部进程占端口)→ verdict=error,
    // 不诱导用户去「装扩展」(装也解决不了)。
    const { createServer } = await import('node:http')
    const blockers: Array<{ close: () => Promise<void> }> = []
    try {
      for (const port of [8791, 8792, 8793, 8794, 8795]) {
        const s = createServer().listen(port, '127.0.0.1')
        await new Promise<void>((r) => s.once('listening', () => r()))
        blockers.push({ close: () => new Promise<void>((r) => s.close(() => r())) })
      }
      await __resetSessionBridgeForTest()
      const r = await sessionFlightSearch({ from: '上海', to: '丽江', date: '2026-12-01' })
      assert.equal(r.verdict, 'error', `端口池全占应 error(环境故障),实 ${r.verdict}:${r.error}`)
      assert.ok(r.error?.includes('端口池'), '错误面必须点明端口池环境问题')
      assert.ok(!r.error?.includes('一次性安装'), 'error 路径不应诱导用户去装扩展')
    } finally {
      await __resetSessionBridgeForTest()
      for (const b of blockers) await b.close()
    }
  })

  const waitingRecord = (verdict: SessionComparableRecord['verdict']): SessionComparableRecord => ({
    query_id: 'sf-01', route_segments: [], journey_type: 'direct', currency: '', price: 0, source: '',
    fetched_at: '', verdict, latency_ms: 0, read_guard_blocked: 0,
  })
  await check('双源合同:needs-extension → waiting_extension(no_spend_waiting_user,waiting-* 同族)', () => {
    const e = evaluateDoubleSource({ session: waitingRecord('needs-extension') })
    assert.equal(e.state, 'waiting_extension')
    assert.equal(e.quota_disposition, 'no_spend_waiting_user')
    assert.equal(e.retry_allowed, false)
  })

  await b.close()

  console.log(`\n§38 extension bridge: ${passed} 段全绿`)
}

main().catch((e) => {
  console.error('FAIL:', e)
  // best-effort cleanup on early failure:关掉所有未释放的桥
  try { __resetSessionBridgeForTest().catch(() => {}) } catch {}
  process.exit(1)
})
