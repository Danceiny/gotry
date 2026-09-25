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
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
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
  localExtensionInstalled,
  needsExtensionSummary,
  __resetSessionBridgeForTest,
  __setSessionBridgeForTest,
  type SessionJobHandle,
} from '../capabilities/session/extension-bridge.ts'
import {
  classifyBridgeFailure,
  extensionCookieNames,
  extensionOpenLogin,
  extensionSearchJob,
} from '../capabilities/session/extension-channel.ts'
import { appendExtensionAudit, resolveTransportMode, sessionFlightSearch, sessionHotelSearch, sessionTrainSearch, __resetRateLimiterForTest } from '../capabilities/session-search.ts'
import { sessionLogin } from '../capabilities/session-login.ts'
import { LOGIN_COOKIE_NAMES, NETWORK_HINTS, SITE_DOMAIN } from '../capabilities/session/adapters/ctrip-flight.ts'
import { HOTEL_NETWORK_HINTS, HOTEL_SITE_HOST, buildHotelEntryUrl } from '../capabilities/session/adapters/ctrip-hotel.ts'
import { TRAIN_NETWORK_HINTS, TRAIN_SITE_HOST } from '../capabilities/session/adapters/rail-12306.ts'
import { DIDA_NETWORK_HINTS, DIDA_LOGIN_COOKIE_NAMES, DIDA_SITE_HOST } from '../capabilities/session/adapters/dida-portal.ts'
import { evaluateDoubleSource, type SessionComparableRecord } from '../capabilities/session/benchmark.ts'
import { factsFromSessionTrain } from '../src/bookable-facts.ts'

const EXT_DIR = fileURLToPath(new URL('../../extension/', import.meta.url))
const UNREF_CHILD = fileURLToPath(new URL('./fixtures/extension-bridge-unref-child.mjs', import.meta.url))
const read = (f: string): string => readFileSync(join(EXT_DIR, f), 'utf8')

async function contentMainRelativeResponseUrlProof(source: string): Promise<Array<{ url: string; body: string }>> {
  const events: Array<{ url: string; body: string }> = []
  const window = {
    __gotrySniffInstalled: false,
    fetch: async function (_input?: unknown, _init?: unknown) {
      return {
        url: 'https://kyfw.12306.cn/otn/leftTicket/queryG?leftTicketDTO.train_date=2026-12-01&leftTicketDTO.from_station=SHH&leftTicketDTO.to_station=KMM',
        headers: { get: () => null },
        clone: () => ({ text: async () => '{"data":{"result":[]}}' }),
      }
    },
    dispatchEvent: (event: { detail?: { url?: string; body?: string } }) => {
      events.push({ url: String(event.detail?.url ?? ''), body: String(event.detail?.body ?? '') })
    },
  }
  class FixtureXhr {
    responseType = ''
    responseText = '{"data":{"result":[]}}'
    response = this.responseText
    responseURL = 'https://kyfw.12306.cn/otn/leftTicket/queryG?leftTicketDTO.train_date=2026-12-01&leftTicketDTO.from_station=SHH&leftTicketDTO.to_station=KMM'
    private listeners: Array<() => void> = []
    addEventListener(event: string, handler: () => void): void {
      if (event === 'load') this.listeners.push(handler)
    }
    open(_method: string, _url: string): void {}
    send(_body?: unknown): void {
      for (const handler of this.listeners) handler()
    }
  }
  class FixtureCustomEvent {
    detail: { url?: string; body?: string }
    constructor(_type: string, init: { detail: { url?: string; body?: string } }) { this.detail = init.detail }
  }
  ;(window as { addEventListener?: () => void }).addEventListener = () => {}
  runInNewContext(source, { window, location: { hostname: 'kyfw.12306.cn' }, XMLHttpRequest: FixtureXhr, CustomEvent: FixtureCustomEvent })
  await window.fetch('/otn/leftTicket/queryG', {})
  const xhr = new FixtureXhr()
  xhr.open('GET', '/otn/leftTicket/queryG')
  xhr.send()
  await new Promise((resolve) => setTimeout(resolve, 0))
  return events
}

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
async function claimOnce(port: number, respond: ((job: FakeJob) => Record<string, unknown> | null) | null, signal?: AbortSignal, capabilities?: string[], origin = EXTENSION_ORIGIN, clientId?: string): Promise<{ job: FakeJob | null }> {
  const r = await fetch(`http://127.0.0.1:${port}/jobs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin },
    body: JSON.stringify({ extensionVersion: 'test', ...(capabilities ? { capabilities } : {}), ...(clientId ? { clientId } : {}) }),
    signal,
  })
  const data = (await r.json()) as { job: FakeJob | null }
  if (data.job && respond) {
    const result = respond(data.job)
    if (result) {
      await fetch(`http://127.0.0.1:${port}/results/${encodeURIComponent(data.job.jobId)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin, ...(clientId ? { 'x-gotry-client-id': clientId } : {}) },
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
    optional_host_permissions?: string[]
    content_scripts: Array<{ matches: string[]; js: string[]; world?: string; run_at?: string }>
    key: string
    version: string
    version_name?: string
    options_page?: string
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

  await check('manifest 合同:MV3 + 最小权限(cookies/alarms;无 storage/options_page/tabs;founder 2026-09-11 不向员工暴露任何配置面)', () => {
    assert.equal(manifest.manifest_version, 3)
    assert.deepEqual([...manifest.permissions].sort(), ['alarms', 'cookies'])
    assert.ok(!manifest.permissions.includes('storage'), '不得用 storage 持久化配置(配置由 portal 静默派发)')
    assert.equal(manifest.options_page, undefined, '不得挂 options 页(employee-facing UI 全禁)')
    assert.equal(manifest.optional_host_permissions, undefined, '门户只签发同源桥路径，未调用运行时授权 API，不得保留全网可选权限')
  })

  const manifestPorts = manifest.host_permissions
    .map((p) => /127\.0\.0\.1:(\d+)/.exec(p)?.[1])
    .filter((v): v is string => v != null)
    .map(Number)
    .sort((a, b) => a - b)
  await check('防漂移:桥端口池(Node BRIDGE_PORTS)= manifest host_permissions 回环面(+ ctrip/dida 星域;2026-09-11 保留站点域:founder 不接受单凭 chrome.cookies API 推断,显式授权链可审计)', () => {
    assert.deepEqual(manifestPorts, [...BRIDGE_PORTS].sort((a, b) => a - b))
    assert.ok(manifest.host_permissions.includes('https://*.ctrip.com/*'))
    assert.ok(manifest.host_permissions.includes('https://*.dida.com/*'))
    assert.ok(manifest.host_permissions.includes('https://dida.com/*'))
  })

  await check('防漂移:content_scripts 双 world 挂 ctrip 双站+12306+dida(MAIN 嗅探 + ISOLATED 桥;2026-09-03 酒/火实装,2026-09-09 dida 实装)', () => {
    assert.equal(manifest.content_scripts.length, 2)
    // 2026-09-21 hotel-fe#3713:join 交付(portal 页注入 window.__gotryJoinTicket)要求
    // content-bridge 也跑在 hotelbyte portal 页上;content-main(供应商页 MAIN 嗅探)维持站点面不变。
    const portalOrigins = ['https://portal-test.hotelbyte.com/*', 'https://portal.hotelbyte.com/*']
    const main = manifest.content_scripts.find((cs) => cs.js[0] === 'content-main.js')
    const bridge = manifest.content_scripts.find((cs) => cs.js[0] === 'content-bridge.js')
    assert.ok(main && bridge, '双 world 脚本齐备')
    const siteMatches = ['https://flights.ctrip.com/*', `https://${HOTEL_SITE_HOST}/*`, `https://${TRAIN_SITE_HOST}/*`, 'https://www.12306.cn/*', `https://${DIDA_SITE_HOST}/*`]
    assert.deepEqual(main!.matches, siteMatches)
    assert.deepEqual(bridge!.matches, [...siteMatches, ...portalOrigins])
    for (const cs of manifest.content_scripts) assert.equal(cs.run_at, 'document_start')
    const worlds = manifest.content_scripts.map((cs) => cs.world ?? 'ISOLATED').sort()
    assert.deepEqual(worlds, ['ISOLATED', 'MAIN'])
    assert.deepEqual(manifest.content_scripts.map((cs) => cs.js[0]).sort(), ['content-bridge.js', 'content-main.js'])
  })

  const backgroundJs = read('background.js')
  const contentMainJs = read('content-main.js')
  const contentBridgeJs = read('content-bridge.js')
  await check('配置交付(2026-09-11 hotelbyte 口径:员工零配置):portal 派发 join ticket → SW 静默接收;无 storage/options UI', () => {
    assert.ok(!backgroundJs.includes('chrome.storage'), '背景 SW 不得读 chrome.storage(配置由 portal 派发,非持久化)')
    assert.ok(!backgroundJs.includes('chrome.storage.local.get'), '背景 SW 不得列读 storage.local.gotryRemoteBridge')
    assert.ok(!backgroundJs.includes('chrome.storage.onChanged'), '背景 SW 不得订阅 storage 变更')
    assert.ok(backgroundJs.includes('chrome.runtime.onMessage'), '背景 SW 应订阅 runtime.onMessage 接收 portal 派发')
    assert.ok(backgroundJs.includes('\'gotry-join\''), '背景 SW 应识别 gotry-join 消息(portal content-bridge 派发)')
    assert.ok(backgroundJs.includes('joinTicket'), '背景 SW 应有 joinTicket 模块变量缓存 ticket')
    assert.ok(backgroundJs.includes('isJoinFresh'), '背景 SW 应有 join ticket 有效性校验(过期/token 缺失即弃)')
    assert.ok(contentBridgeJs.includes('__gotryJoinTicket'), 'content-bridge 应在页面里读 window.__gotryJoinTicket')
    assert.ok(contentBridgeJs.includes('type: \'gotry-join\''), 'content-bridge 应把 ticket 转 gotry-join 消息派给 SW')
    assert.ok(contentBridgeJs.includes('chrome.runtime.sendMessage'), 'content-bridge 应用 chrome.runtime.sendMessage 派发')
    assert.ok(!backgroundJs.includes('options.html'), '扩展不得引用 options.html/options.js(employee 零配置)')
  })
  await check('安装检测契约(2026-09-24 hotel-fe#3802):content-bridge 在 portal 页给 <body> 打 data-portal-helper-installed 标记,横幅据此隐藏', () => {
    assert.ok(contentBridgeJs.includes('data-portal-helper-installed'), 'content-bridge 应设置 portal 安装检测属性(hotel-fe 横幅的唯一检测面)')
    assert.ok(contentBridgeJs.includes('markInstalled'), '应有 markInstalled 封装(document_start 下 body 常为 null,需兜底)')
    assert.ok(/DOMContentLoaded[^\n]*markInstalled/.test(contentBridgeJs), 'body 未就绪时需 DOMContentLoaded 兜底打标记')
  })
  await check('代填登录(2026-09-21 hotel-fe#3713 形态 A 免密进入门户):portal 投递载荷 → SW 开登录页 → content-bridge 按站点配方填表,账密零持久面', () => {
    assert.ok(backgroundJs.includes("'gotry-portal-login'"), 'SW 应识别 portal 投递的一次性凭据载荷')
    assert.ok(backgroundJs.includes('openLoginAndFill'), 'SW 应有「开登录页 + 派发填表」实现')
    assert.ok(backgroundJs.includes('SITE_SEARCH_PREFIXES[site]'), '登录 URL 必须按站点白名单前缀守域(拒绝任意载荷)')
    assert.ok(backgroundJs.includes("'gotry-fill-login'"), 'SW 应向登录页 content-bridge 派发填表指令')
    assert.ok(contentBridgeJs.includes("'gotry-fill-login'"), 'content-bridge 应响应填表指令')
    assert.ok(contentBridgeJs.includes('setNativeValue'), 'React 受控 input 必须走原型 setter + input/change 事件')
    assert.ok(contentBridgeJs.includes('requestSubmit'), '无提交按钮时应回退 form.requestSubmit')
    assert.ok(contentBridgeJs.includes('__gotryPortalLogin'), 'content-bridge 应读 portal 注入的凭据载荷')
    assert.ok(!backgroundJs.includes('chrome.storage'), '账密不得落持久存储(与 2026-09-11 零配置裁定一致)')
  })
  await check('dida 目的地搜索驱动(2026-09-21):portal 页配方(目的地组首项 + button[name=search])→ 落地 URL 用我们的日期重写', () => {
    assert.ok(contentBridgeJs.includes('runDidaSearch'), 'content-bridge 应有 dida 目的地搜索配方')
    assert.ok(contentBridgeJs.includes('nd-suggestion-result__group'), '配方应取门户联想结果分组(目的地组优先)')
    assert.ok(contentBridgeJs.includes('nd-suggestion-search__label'), '配方应识别分组标题以区分目的地/酒店')
    assert.ok(contentBridgeJs.includes('button[name="search"]'), '配方应点门户查询按钮')
    assert.ok(contentBridgeJs.includes('ant-modal-wrap'), '配方应先关 cookie 授权弹窗(否则点击被遮罩吞掉)')
    assert.ok(backgroundJs.includes("'gotry-dida-search'"), 'SW 应向 content-bridge 下发配方指令')
    assert.ok(backgroundJs.includes("searchParams.set('checkInDate'"), 'SW 应用我们的日期重写落地 URL(不驱动门户日期选择器)')
    assert.ok(backgroundJs.includes('landingUrl'), 'SW 应回传落地 URL(供解析器与诊断)')
  })
  await check('dida 查询态(2026-09-21):searchCache 桶 + 只认 searchCache 的等待器 + 页面级挑战标记', () => {
    assert.ok(backgroundJs.includes("if (/HotelPriceAPI\\/SearchCache/i.test(url)) return 'searchCache'"), 'SW 应把 SearchCache 分到 searchCache 桶')
    assert.ok(backgroundJs.includes('waitSniffSearchCache'), '查询态应有只认 searchCache 的等待器(推荐流不得参与结算)')
    assert.ok(backgroundJs.includes('challenge'), 'SW 应把页面级 challenge 标记随结果回传')
    assert.ok(contentBridgeJs.includes('challengeHint'), 'content-bridge 应按 DOM 判定挑战标记')
    assert.ok(backgroundJs.includes('landingUrl'), '驱动后应回传落地 URL')
  })
  await check('dida multiCollect(2026-09-11,推荐流双接口):背景分类函数 + waitSniffMulti 分桶结算', () => {
    assert.ok(backgroundJs.includes('classifyDidaSniff'), '背景 SW 应抽 dida sniff 分类函数')
    assert.ok(backgroundJs.includes('SearchHomepageRecommendHotels'), '多回包分类应含 hotels 接口')
    assert.ok(backgroundJs.includes('SearchHomepageRecommendPrices'), '多回包分类应含 recommendPrices 接口')
    assert.ok(backgroundJs.includes('waitSniffMulti'), '应有多回包分桶结算版本(双齐即返)')
    assert.ok(backgroundJs.includes('job.multiCollect'), '背景 SW 应按 job.multiCollect 分派单首包/多回包')
  })
  await check('版本跟随主版本:manifest version_name = package.json version;version = 四段投影(0.0.1-rc.N → 0.0.1.N,founder 2026-09-03 拍板)', () => {
    const pkgVersion = (JSON.parse(readFileSync(join(EXT_DIR, '..', 'package.json'), 'utf8')) as { version: string }).version
    assert.equal(manifest.version_name, pkgVersion, 'version_name 应与 gotry 主版本逐字一致')
    const m = /^(\d+)\.(\d+)\.(\d+)-rc\.(\d+)$/.exec(pkgVersion)
    assert.ok(m, `主版本形态应为 x.y.z-rc.N,实际 ${pkgVersion}`)
    assert.equal(manifest.version, `${m![1]}.${m![2]}.${m![3]}.${m![4]}`, 'version 应为主版本的四段投影(Chrome manifest 只收点分整数)')
    assert.equal(manifest.content_scripts.length, 2)
  })
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
    assert.ok(backgroundJs.includes("'dida-portal'"), 'background SITES 应注册 dida-portal(2026-09-09 实装)')
    assert.ok(backgroundJs.includes('https://portal.dida.com/'), 'background 应含 dida 检索白名单')
    assert.ok(contentMainJs.includes('gotry-ctrip-sniff'))
    assert.ok(contentBridgeJs.includes('gotry-ctrip-sniff'))
    assert.ok(contentBridgeJs.includes('url: d.url'), 'content bridge 应转发嗅探响应 URL')
    assert.ok(backgroundJs.includes('url: String(msg.url ??'), 'background 应保留嗅探响应 URL')
    assert.ok(contentMainJs.includes('typeof res.url === \'string\''), 'content-main fetch 应读取浏览器 response.url')
    assert.ok(contentMainJs.includes('typeof xhr.responseURL === \'string\''), 'content-main XHR 应读取浏览器 responseURL')
    assert.ok(contentBridgeJs.includes('gotry-page'))
  })
  await check('相对 12306 输入 → fetch/XHR 均转发同一响应的绝对 URL 与 body', async () => {
    const events = await contentMainRelativeResponseUrlProof(contentMainJs)
    const expectedUrl = 'https://kyfw.12306.cn/otn/leftTicket/queryG?leftTicketDTO.train_date=2026-12-01&leftTicketDTO.from_station=SHH&leftTicketDTO.to_station=KMM'
    assert.deepEqual(events, [
      { url: expectedUrl, body: '{"data":{"result":[]}}' },
      { url: expectedUrl, body: '{"data":{"result":[]}}' },
    ])
  })
  await check('防漂移(Dida):DIDA_NETWORK_HINTS(Node)= content-main 嗅探面;票据名= background SITES;manifest 覆盖 portal.dida.com', () => {
    for (const hint of DIDA_NETWORK_HINTS) {
      assert.ok(stripRe(contentMainJs).includes(stripRe(hint.source)), `content-main.js 缺 dida hint ${hint.source}`)
    }
    assert.ok(contentMainJs.includes('portal\\.dida\\.com'), 'content-main.js 应感知 dida 页域')
    for (const name of DIDA_LOGIN_COOKIE_NAMES) {
      assert.ok(backgroundJs.includes(`'${name}'`), `background.js 缺 dida 票据名 ${name}`)
    }
    assert.ok(backgroundJs.includes("domain: 'dida.com'"), 'background.js dida 站点域应与 LOGIN_TARGETS.domain 对账')
    const manifestAny = JSON.parse(readFileSync(join(EXT_DIR, 'manifest.json'), 'utf8')) as { host_permissions: string[]; content_scripts: Array<{ matches: string[] }> }
    assert.ok(manifestAny.host_permissions.includes('https://*.dida.com/*'), 'manifest host_permissions 应含 dida 域')
    assert.ok(manifestAny.content_scripts.every((b) => b.matches.includes(`https://${DIDA_SITE_HOST}/*`)), 'manifest 两组 content_scripts 均应注入 portal.dida.com')
    assert.ok(stripRe(contentMainJs).includes('"HotelPriceList"|"RatePlanList"'), 'dida 形状签名两侧必须逐字一致')
  })
  await check('扩展 fetch 只指向桥(loopback / 门户同源桥 URL / bridgeBase() / joinTicket.bridgeUrl 含 .replace 派生 / 变量别名 url);不用 chrome.debugger;站点域一律 zero fetch', () => {
    for (const [name, src] of [['background', backgroundJs], ['content-main', contentMainJs], ['content-bridge', contentBridgeJs]] as const) {
      // joinTicket.bridgeUrl 分支用 [^}]* 而非 [^)]*:允许同一变量的 .replace(...) 等纯派生表达式(如去尾斜杠),
      // 派生链一旦写出嵌套 `${}` 或新目标即不再命中——只放宽对同一变量的匹配,不放宽目标集合(fail-closed)。
      const bridgeFetches = src.match(/fetch\(`?(?:http:\/\/127\.0\.0\.1|\$\{bridgeBase\(\)\}|\$\{remoteBridge\.baseUrl\}|\$\{joinTicket\.bridgeUrl[^}]*\})|\bfetch\(\s*url\b/g) ?? []
      const allFetches = src.match(/fetch\(/g) ?? []
      assert.equal(bridgeFetches.length, allFetches.length, `${name}: fetch 必须只指向桥；门户另有登录代填和搜索控件操作`)
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

  await check('已领取作业的回包只接受领取它的扩展 Origin', async () => {
    const lane = await mustBridge([0])
    try {
      const pending = lane.submit({ kind: 'search', site: 'ctrip-flight', url: 'https://flights.ctrip.com/online/list/oneway-sha-ljg?depdate=2026-12-01' })
      const claimed = await claimOnce(lane.port, null)
      assert.equal(claimed.job?.kind, 'search')
      const target = `http://127.0.0.1:${lane.port}/results/${encodeURIComponent(claimed.job!.jobId)}`
      const forged = await fetch(target, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: EXTENSION_ORIGIN_STORE },
        body: JSON.stringify({ ok: false, kind: 'search', error: 'other-origin-result' }),
      })
      assert.equal(forged.status, 403)
      const valid = await fetch(target, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: EXTENSION_ORIGIN },
        body: JSON.stringify({ ok: true, kind: 'search', body: '{"data":{"flightItineraryList":[]}}', title: '机票列表' }),
      })
      assert.equal(valid.status, 200)
      const outcome = await pending
      assert.equal(outcome.ok, true)
      if (outcome.ok) assert.equal(outcome.origin, EXTENSION_ORIGIN)
    } finally {
      await lane.close()
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

  await check('扩展作业失败必须保留 job-error,不能伪装成未登录或空搜索响应', async () => {
    const cases = [
      { kind: 'cookie-names', invoke: () => extensionCookieNames({ site: 'ctrip-flight', domain: 'ctrip.com', ticketNames: ['cticket'] }, b) },
      { kind: 'search', invoke: () => extensionSearchJob({ site: 'ctrip-flight', url: 'https://flights.ctrip.com/online/list/oneway-sha-ljg?depdate=2026-10-01' }, b) },
      { kind: 'open-login', invoke: () => extensionOpenLogin({ site: 'ctrip-flight', url: 'https://passport.ctrip.com/' }, b) },
    ] as const
    for (const item of cases) {
      const pending = item.invoke()
      const claimed = await claimOnce(port, (job) => {
        assert.equal(job.kind, item.kind)
        return { ok: false, kind: item.kind, error: 'browser tab creation failed' }
      })
      assert.ok(claimed.job)
      const result = await pending
      assert.equal(result.ok, false, `${item.kind} must expose the extension failure`)
      if (!result.ok) {
        assert.equal(result.kind, 'job-error')
        assert.match(result.summary, /browser tab creation failed/)
      }
    }
  })

  await check('检索嗅探到点仍保留页面标题,供挑战红线判定', async () => {
    const pending = extensionSearchJob({ site: 'ctrip-flight', url: 'https://flights.ctrip.com/online/list/oneway-sha-ljg?depdate=2026-10-01' }, b)
    const claimed = await claimOnce(port, (job) => {
      assert.equal(job.kind, 'search')
      return { ok: false, kind: 'search', timeout: true, url: '', title: '安全验证' }
    })
    assert.ok(claimed.job)
    const result = await pending
    assert.equal(result.ok, true)
    if (result.ok) {
      assert.equal(result.timedOut, true)
      assert.equal(result.title, '安全验证')
    }
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
                const requestedUrl = new URL(u)
                const requestedDate = requestedUrl.searchParams.get('date') ?? '2026-12-01'
                const wrongRoute = requestedUrl.searchParams.get('fs')?.endsWith(',BJP') === true
                const wrongDateEmpty = requestedDate === '2026-12-02'
                const trainResponseUrl = wrongRoute
                  ? `https://kyfw.12306.cn/otn/leftTicket/queryG?leftTicketDTO.train_date=${requestedDate}&leftTicketDTO.from_station=SHH&leftTicketDTO.to_station=KMM`
                  : `https://kyfw.12306.cn/otn/leftTicket/queryG?leftTicketDTO.train_date=${wrongDateEmpty ? '2026-12-01' : requestedDate}&leftTicketDTO.from_station=SHH&leftTicketDTO.to_station=KMM`
                return {
                  ok: true,
                  kind: 'search',
                  body: isHotel
                    ? JSON.stringify({ data: { hotelList: [{ hotelId: 442516, hotelName: 'Hotel X', star: 5, commentScore: 4.7, priceInfo: { avgPrice: 680 } }] } })
                    : isTrain
                      ? JSON.stringify({ data: { result: wrongDateEmpty ? [] : ['|预订|24000000G1375|G1375|SHH|KMM|SHH|KMM|07:35|15:27|07:52|Y|yp|20261201|x|loc|01|02|Y|0|--|--|--|--|--|--|有|--|--|有|有|有|有|--|ex|st|'], map: { SHH: '上海南', KMM: '昆明' } } })
                      : JSON.stringify({ data: { flightItineraryList: [] } }),
                  url: isTrain ? trainResponseUrl : u,
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
      assert.equal(search.ok ? search.url : '', 'https://flights.ctrip.com/online/list/oneway-sha-ljg?depdate=2026-12-01', '响应 URL 穿过 background/result/channel')

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
      assert.equal(trainSession.collection?.response.url, 'https://kyfw.12306.cn/otn/leftTicket/queryG?leftTicketDTO.train_date=2026-12-01&leftTicketDTO.from_station=SHH&leftTicketDTO.to_station=KMM', '火车响应 URL 穿过扩展桥并绑定 collection')

      __resetRateLimiterForTest()
      const wrongRoute = await sessionTrainSearch({ from: '北京', to: '上海', date: '2026-12-03', timeoutMs: 3_000 })
      assert.equal(wrongRoute.collection, undefined, 'wrong-route response URL → no collection')
      assert.equal(factsFromSessionTrain({ from: '北京', to: '上海', date: '2026-12-03' }, wrongRoute).length, 0, 'wrong-route collector result → zero facts')

      __resetRateLimiterForTest()
      const wrongDateEmpty = await sessionTrainSearch({ from: '上海', to: '昆明', date: '2026-12-02', timeoutMs: 3_000 })
      assert.equal(wrongDateEmpty.outcome.kind, 'recognized-empty', 'wrong-date seam keeps parsed empty presentation')
      assert.equal(wrongDateEmpty.collection, undefined, 'wrong-date empty response URL → no collection')
      assert.equal(factsFromSessionTrain({ from: '上海', to: '昆明', date: '2026-12-02' }, wrongDateEmpty).length, 0, 'wrong-date empty collector result → zero facts')

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

  await check('同次机票会话的检索只能由完成票据预检的扩展 Origin 领取', async () => {
    const lane = await mustBridge([0])
    __setSessionBridgeForTest(lane)
    const storeAbort = new AbortController()
    const unpackedAbort = new AbortController()
    let storeGotSearch = false
    let unpackedGotSearch = false
    let storePoll: Promise<{ job: FakeJob | null }> | undefined
    let unpackedSearchPoll: Promise<{ job: FakeJob | null }> | undefined
    try {
      __resetRateLimiterForTest()
      const cookiePoll = claimOnce(lane.port, null)
      await waitForParkedCount(lane.port, 1)
      const search = sessionFlightSearch({ from: '上海', to: '丽江', date: '2026-12-01', timeoutMs: 3_000 })
      const cookieClaim = await cookiePoll
      assert.equal(cookieClaim.job?.kind, 'cookie-names')

      // 商店版先候在桥上；它不得接走另一 Origin 已验证登录态后的 search。
      storePoll = claimOnce(lane.port, (job) => {
        storeGotSearch = true
        return { ok: false, kind: job.kind, error: 'wrong-extension-origin' }
      }, storeAbort.signal, ['ctrip-flight'], EXTENSION_ORIGIN_STORE).catch(() => ({ job: null }))
      await waitForParkedCount(lane.port, 1)
      const cookieResult = await fetch(`http://127.0.0.1:${lane.port}/results/${encodeURIComponent(cookieClaim.job!.jobId)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: EXTENSION_ORIGIN },
        body: JSON.stringify({ ok: true, kind: 'cookie-names', names: ['cticket'] }),
      })
      assert.equal(cookieResult.status, 200)

      unpackedSearchPoll = claimOnce(lane.port, (job) => {
        assert.equal(job.kind, 'search')
        unpackedGotSearch = true
        return { ok: true, kind: 'search', body: JSON.stringify({ data: { flightItineraryList: [] } }), url: job.url, title: '机票列表' }
      }, unpackedAbort.signal, ['ctrip-flight'], EXTENSION_ORIGIN).catch(() => ({ job: null }))
      const result = await search
      assert.equal(result.verdict, 'miss', `同一 Origin 应完成检索,实际 ${result.verdict}:${result.error ?? ''}`)
      assert.equal(unpackedGotSearch, true)
      assert.equal(storeGotSearch, false)
    } finally {
      storeAbort.abort()
      unpackedAbort.abort()
      await Promise.allSettled([storePoll, unpackedSearchPoll].filter((p): p is Promise<{ job: FakeJob | null }> => p !== undefined))
      await __resetSessionBridgeForTest()
      __setSessionBridgeForTest(null)
      await lane.close()
      __resetRateLimiterForTest()
    }
  })

  await check('同一 Origin 的两个 Chrome 配置不能交叉领取预检后的检索或提交结果', async () => {
    const lane = await mustBridge([0])
    __setSessionBridgeForTest(lane)
    const clientA = '11111111-1111-4111-8111-111111111111'
    const clientB = '22222222-2222-4222-8222-222222222222'
    const otherAbort = new AbortController()
    const sameAbort = new AbortController()
    let otherGotSearch = false
    let sameGotSearch = false
    let otherPoll: Promise<{ job: FakeJob | null }> | undefined
    let samePoll: Promise<{ job: FakeJob | null }> | undefined
    try {
      __resetRateLimiterForTest()
      const cookiePoll = claimOnce(lane.port, null, undefined, ['ctrip-flight'], EXTENSION_ORIGIN, clientA)
      await waitForParkedCount(lane.port, 1)
      const search = sessionFlightSearch({ from: '上海', to: '丽江', date: '2026-12-01', timeoutMs: 3_000 })
      const cookieClaim = await cookiePoll
      assert.equal(cookieClaim.job?.kind, 'cookie-names')
      otherPoll = claimOnce(lane.port, (job) => {
        otherGotSearch = true
        return { ok: false, kind: job.kind, error: 'wrong-chrome-profile' }
      }, otherAbort.signal, ['ctrip-flight'], EXTENSION_ORIGIN, clientB).catch(() => ({ job: null }))
      await waitForParkedCount(lane.port, 1)
      const wrongClientResult = await fetch(`http://127.0.0.1:${lane.port}/results/${encodeURIComponent(cookieClaim.job!.jobId)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: EXTENSION_ORIGIN, 'x-gotry-client-id': clientB },
        body: JSON.stringify({ ok: false, kind: 'cookie-names', error: 'wrong-chrome-profile' }),
      })
      assert.equal(wrongClientResult.status, 403)
      const cookieResult = await fetch(`http://127.0.0.1:${lane.port}/results/${encodeURIComponent(cookieClaim.job!.jobId)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: EXTENSION_ORIGIN, 'x-gotry-client-id': clientA },
        body: JSON.stringify({ ok: true, kind: 'cookie-names', names: ['cticket'] }),
      })
      assert.equal(cookieResult.status, 200)
      samePoll = claimOnce(lane.port, (job) => {
        assert.equal(job.kind, 'search')
        sameGotSearch = true
        return { ok: true, kind: 'search', body: JSON.stringify({ data: { flightItineraryList: [] } }), url: job.url, title: '机票列表' }
      }, sameAbort.signal, ['ctrip-flight'], EXTENSION_ORIGIN, clientA).catch(() => ({ job: null }))
      const result = await search
      assert.equal(result.verdict, 'miss', `同一客户端应完成检索,实际 ${result.verdict}:${result.error ?? ''}`)
      assert.equal(sameGotSearch, true)
      assert.equal(otherGotSearch, false)
    } finally {
      otherAbort.abort()
      sameAbort.abort()
      await Promise.allSettled([otherPoll, samePoll].filter((p): p is Promise<{ job: FakeJob | null }> => p !== undefined))
      await __resetSessionBridgeForTest()
      __setSessionBridgeForTest(null)
      await lane.close()
      __resetRateLimiterForTest()
    }
  })

  await check('机票检索嗅探超时应说明未收到回包,不误报 batchSearch 形状异常', async () => {
    const lane = await mustBridge([0])
    __setSessionBridgeForTest(lane)
    let done = false
    const claimLoop = (async () => {
      while (!done) {
        const ac = new AbortController()
        const bail = setTimeout(() => ac.abort(), 2_000)
        try {
          await claimOnce(lane.port, (job) => {
            if (job.kind === 'cookie-names') return { ok: true, kind: 'cookie-names', names: ['cticket'] }
            assert.equal(job.kind, 'search')
            assert.equal(job.site, 'ctrip-flight')
            return { ok: false, kind: 'search', timeout: true, url: '', title: '机票列表' }
          }, ac.signal)
        } catch { /* 等待取活时中止 */ }
        clearTimeout(bail)
      }
    })()
    try {
      __resetRateLimiterForTest()
      const result = await sessionFlightSearch({ from: '上海', to: '丽江', date: '2026-12-01', timeoutMs: 3_000 })
      assert.equal(result.verdict, 'error')
      assert.match(result.error ?? '', /嗅探超时|未收到.*回包/)
      assert.doesNotMatch(result.error ?? '', /响应形状异常/)
    } finally {
      done = true
      await claimLoop
      await __resetSessionBridgeForTest()
      __setSessionBridgeForTest(null)
      await lane.close()
      __resetRateLimiterForTest()
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
  await check('capability 路由:站点 job 只派给声明该站点的轮询者(同机多 Chrome 旧版扩展不毒领新站点 job)', async () => {
    const lane = await mustBridge([0])
    const pause = (ms: number) => new Promise((r) => setTimeout(r, ms))
    try {
      // 旧版扩展(caps 无 dida-portal,模拟商店版)先 parked
      const oldExtP = claimOnce(lane.port, null, undefined, ['ctrip-flight', 'ctrip-hotel', 'train-12306']).catch(() => ({ job: null }))
      await pause(200)
      // dida job 提交:不得派给旧版扩展(它不声明 dida-portal)
      const submitP = lane.submit({ kind: 'cookie-names', site: 'dida-portal' }, { timeoutMs: 3_000 })
      await pause(200)
      const stoleByOld = await Promise.race([oldExtP.then(() => true), pause(400).then(() => false)])
      assert.ok(!stoleByOld, '旧版扩展(capability 不含 dida-portal)不得领走 dida job')
      // 新版扩展声明 dida-portal → 立即领到
      const newExtGot = await claimOnce(lane.port, (job) => {
        assert.equal(job.kind, 'cookie-names')
        return { ok: true, kind: 'cookie-names', names: ['CN_M_DidaTravel'] }
      }, undefined, ['ctrip-flight', 'ctrip-hotel', 'train-12306', 'dida-portal'])
      assert.ok(newExtGot.job && newExtGot.job.site === 'dida-portal', `声明 dida-portal 的扩展领到 job: ${JSON.stringify(newExtGot.job)}`)
      const outcome = await submitP
      assert.ok(outcome.ok && outcome.result.names?.includes('CN_M_DidaTravel'), `job 结果正确回传: ${JSON.stringify(outcome)}`)
      // 正向:capability 匹配的 parked 轮询者即时收到新提交的 ctrip job
      const ctripP = lane.submit({ kind: 'cookie-names', site: 'ctrip-flight' }, { timeoutMs: 3_000 })
      await pause(100)
      const parkedOld = await Promise.race([oldExtP, pause(500).then(() => null)])
      assert.ok(parkedOld && parkedOld.job && parkedOld.job.site === 'ctrip-flight', `旧版扩展领走自己 capability 内的 job: ${JSON.stringify(parkedOld?.job)}`)
      await ctripP.catch(() => ({ ok: false } as const))
    } finally {
      await lane.close()
    }
  })

  await check('双源合同:needs-extension → waiting_extension(no_spend_waiting_user,waiting-* 同族)', () => {
    const e = evaluateDoubleSource({ session: waitingRecord('needs-extension') })
    assert.equal(e.state, 'waiting_extension')
    assert.equal(e.quota_disposition, 'no_spend_waiting_user')
    assert.equal(e.retry_allowed, false)
  })

  // D-24 自适应文案(issue #117):按本地通道是否落位自动跳过开发者模式/本地通道指引
  await check('needs-extension 自适应文案:本地已落位 → 双通道完整指引(含开发者模式)', () => {
    const s = needsExtensionSummary({ localInstalled: true })
    assert.match(s, /开发者模式「加载已解压的扩展程序」/, '本地通道在 → 保留开发者模式指引')
    assert.ok(s.includes(EXTENSION_STORE_URL), '商店 URL 仍在')
  })
  await check('needs-extension 自适应文案:本地未落位(商店版用户/未装)→ 自动跳过 dev-mode 文案', () => {
    const s = needsExtensionSummary({ localInstalled: false })
    assert.doesNotMatch(s, /开发者模式/, '不再推开发者模式/本地通道(商店版用户不该被指导 load unpacked)')
    assert.doesNotMatch(s, /加载已解压/, '不再出现 load unpacked 字样')
    assert.match(s, /已从 Chrome 商店安装/, '给「已装商店版?」提示(打开 Chrome 即可,无需再装)')
    assert.match(s, /应用商店一键装/, '未装用户仍得商店一键装指引')
  })
  // #559 B 步:影响面行必须显式列出挂的工具 + 不影响哪些(避免用户以为整盘不可用)
  await check('needs-extension 影响面(issue #559 B 步):本地已落位文案末尾必带影响面行', () => {
    const s = needsExtensionSummary({ localInstalled: true })
    assert.match(s, /影响面[:：]/, '影响面前缀必现')
    assert.match(s, /gotry_session_search/, '必显挂的账号会话工具')
    assert.match(s, /gotry_session_login/, '必显登录引导工具')
    assert.match(s, /其它工具/, '必显「其它不受影响」(避免用户误以为整盘挂)')
  })
  await check('needs-extension 影响面(issue #559 B 步):本地未落位文案末尾必带影响面行', () => {
    const s = needsExtensionSummary({ localInstalled: false })
    assert.match(s, /影响面[:：]/, '影响面前缀必现(商店版用户同样需要知道挂哪些)')
    assert.match(s, /gotry_session_search/, '必显挂的账号会话工具')
    assert.match(s, /其它工具/, '必显「其它不受影响」')
  })
  await check('localExtensionInstalled:HOME 注入可测(manifest 存在=本地通道在)', () => {
    const fakeHome = mkdtempSync(join(tmpdir(), 'gotry-ext-home-'))
    assert.equal(localExtensionInstalled(fakeHome), false, '空 HOME → 本地通道未落位')
    mkdirSync(join(fakeHome, '.gotry', 'extension'), { recursive: true })
    writeFileSync(join(fakeHome, '.gotry', 'extension', 'manifest.json'), '{}', 'utf-8')
    assert.equal(localExtensionInstalled(fakeHome), true, 'manifest 落位 → true')
    rmSync(fakeHome, { recursive: true, force: true })
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
