/**
 * GoTry Session Bridge — MV3 Service Worker(RFC docs/rfc/user-session-data-rfc.md §2.2 通道 C,2026-08-29 定案为 PRIMARY 传输)。
 *
 * 职责(与 Node 侧 session/extension-bridge.ts 配对,零构建纯 JS):
 *   - 长轮询取活:POST /jobs(桥最多 hold 20s;每次响应/失败都重置 SW 30s 生命周期,任务秒级触达);
 *     断线每 5s 重试,chrome.alarms(30s)兜底唤醒防 SW 悬挂。
 *   - 三种 job:
 *       search       → 后台标签打开 job.url(per-site 白名单:flights/hotels.ctrip.com),等 content hook 嗅探回包,收尾关自己的标签;
 *       open-login   → 置前台打开登录入口页(登录页纪律 #34),标签留给用户,绝不代关;
 *       cookie-names → chrome.cookies 只读票据 cookie **名字**(值即取即弃,永不离开扩展——红线)。
 *   - 物理只读(ReadGuard 扩展车道形态):本 SW 绝不向站点发任何请求——检索请求由站点自己的
 *     页面代码发出,我们只「导航 + 被动转发 NETWORK_HINTS 命中响应」;写不是被禁止的行为,是不存在的原语。
 *
 * 桥地址(2026-09-11,founder 定案:执行环境=浏览器客户端,服务端零 Chrome):
 *   扩展**完全不暴露任何配置**给员工。hotel-be portal 在员工已登录的页面里通过
 *   content-bridge.js 派发 `gotry-join` 消息({bridgeUrl, token}),SW 缓存到
 *   `joinTicket` 模块变量;员工从未看见 URL / token / API host 等技术字眼。
 *   SW 进程重启(约每 30s 节律)→ ticket 丢失 → 下次员工打开 portal 页面自动重发 → 静默恢复。
 *
 *   桌面形态(loopback 端口池)保留向后兼容:无 join ticket 时回退到 127.0.0.1 探测,
 *   这是 gotry 桌面开发场景(gotry CLI 同机形态),与员工日常产品路径无关。
 */

'use strict'

const BRIDGE_PORTS = [8791, 8792, 8793, 8794, 8795]
const RETRY_MS = 5_000

/** 站点注册表(与 Node 侧 LOGIN_TARGETS/LOGIN_COOKIE_NAMES 对账,防漂移测试守住) */
const SITES = {
  'ctrip-flight': {
    domain: 'ctrip.com',
    ticketNames: ['cticket', 'uid', 'uname', 'passport'],
  },
  // 酒店(2026-09-03 实装):同一携程账号体系;检索走 hotels.ctrip.com 后台标签 + 被动嗅探
  'ctrip-hotel': {
    domain: 'ctrip.com',
    ticketNames: ['cticket', 'uid', 'uname', 'passport'],
  },
  // 火车(2026-09-03 实装):12306 余票查询是公开面(登录只关系下单),无票据名可检;
  // search job 照常经 per-site 白名单,扩展只读被动嗅探
  'train-12306': {
    domain: '12306.cn',
    ticketNames: [],
  },
  // Dida 供应商门户(2026-09-09 实装;hotel-be portal integration 迁移线):
  // 员工登录态(HttpOnly 会话 cookie 只读名字,值即取即弃);检索走 portal.dida.com
  // 后台标签 + 被动嗅探 portal-webapi 实时价
  'dida-portal': {
    domain: 'dida.com',
    ticketNames: ['CN_M_DidaTravel'],
  },
}

/** 检索 URL 白名单(per-site;search job 只允许开各自站点域,其余一律拒) */
const SITE_SEARCH_PREFIXES = {
  'ctrip-flight': 'https://flights.ctrip.com/',
  'ctrip-hotel': 'https://hotels.ctrip.com/',
  'train-12306': 'https://kyfw.12306.cn/',
  'dida-portal': 'https://portal.dida.com/',
}

/**
 * join ticket:由 hotel-be portal 通过 content-bridge 派发,SW 缓存;
 * 模块级变量,SW 重启即清空(下次 portal 页派发即恢复,无需持久化)。
 * 形态:{ bridgeUrl, token, issuedAt, expiresAt }
 */
let joinTicket = null
let activePort = null
let polling = false

function isJoinFresh(t) {
  if (!t || typeof t.bridgeUrl !== 'string' || !t.bridgeUrl) return false
  if (t.expiresAt && Number.isFinite(Date.parse(t.expiresAt)) && Date.parse(t.expiresAt) < Date.now()) return false
  return true
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function detectBridge() {
  // 远程 join ticket 优先:portal 派发则连远程
  if (isJoinFresh(joinTicket)) {
    try {
      const r = await fetch(`${joinTicket.bridgeUrl.replace(/\/+$/, '')}/health`, {
        headers: { authorization: `Bearer ${joinTicket.token ?? ''}`, 'x-gotry-bridge': 'v1' },
      })
      if (r.ok) return true
    } catch { /* 远程暂不可达;若也无可用 loopback 则继续重试 */ }
  }
  // 桌面形态兜底:loopback 端口池扫描
  for (const p of BRIDGE_PORTS) {
    try {
      const r = await fetch(`http://127.0.0.1:${p}/health`, { headers: { 'x-gotry-bridge': 'v1' } })
      if (r.ok) { activePort = p; return true }
    } catch { /* 无人监听,试下一个端口 */ }
  }
  return false
}

function bridgeBase() {
  if (isJoinFresh(joinTicket)) return joinTicket.bridgeUrl.replace(/\/+$/, '')
  return activePort != null ? `http://127.0.0.1:${activePort}` : null
}

function bridgeHeaders(withJson) {
  const h = { 'x-gotry-bridge': 'v1' }
  if (withJson) h['content-type'] = 'application/json'
  if (isJoinFresh(joinTicket) && joinTicket.token) h['authorization'] = `Bearer ${joinTicket.token}`
  return h
}

async function postResult(jobId, result) {
  const base = bridgeBase()
  if (base == null || !jobId) return
  // 远程桥挂载在 gotry-backend 精确路由内核上,jobId 走 query;loopback 独立桥保持路径式
  const url = isJoinFresh(joinTicket)
    ? `${base}/results?jobId=${encodeURIComponent(jobId)}`
    : `${base}/results/${encodeURIComponent(jobId)}`
  try {
    await fetch(url, {
      method: 'POST',
      headers: bridgeHeaders(true),
      body: JSON.stringify(result),
    })
  } catch { /* 桥可能已退场;Node 侧超时兜底 */ }
}

/** 只读票据 cookie 名单(只上报名;chrome.cookies 的值就地丢弃,不进任何结果对象) */
async function ticketNames(site) {
  const conf = SITES[site]
  if (!conf) return []
  const cookies = await chrome.cookies.getAll({ domain: conf.domain }).catch(() => [])
  return (Array.isArray(cookies) ? cookies : [])
    .map((c) => c.name)
    .filter((n) => conf.ticketNames.includes(n))
}

/** dida 推荐流多回包分类(与 Node 侧 mergeDidaRatesBodies 对账,run-all §38 防漂移断言守住) */
function classifyDidaSniff(url) {
  if (/SearchHomepageRecommendHotels/i.test(url)) return 'hotels'
  if (/SearchHomepageRecommendPrices/i.test(url)) return 'recommendPrices'
  if (/HotelPriceAPI\/SearchRealTime/i.test(url)) return 'realtime'
  return null
}

/** multiCollect(dida 推荐流):hotels+recommendPrices 齐即结算;超时带回已见分桶(诚实缺桶) */
function waitSniffMulti(tabId, timeoutMs) {
  return new Promise((resolve) => {
    const bodies = {}
    let settled = false
    let title = ''
    const finish = () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      chrome.runtime.onMessage.removeListener(handler)
      resolve({ ok: true, kind: 'search', bodies, title, timeout: !(bodies.hotels && bodies.recommendPrices) })
    }
    const handler = (msg, sender) => {
      if (!sender || !sender.tab || sender.tab.id !== tabId) return
      if (msg && msg.type === 'gotry-page') { title = String(msg.title ?? title); return }
      if (msg && msg.type === 'gotry-sniff') {
        const cls = classifyDidaSniff(String(msg.url ?? ''))
        if (cls && !bodies[cls]) bodies[cls] = String(msg.body ?? '')
        if (bodies.hotels && bodies.recommendPrices) finish()
      }
    }
    const timer = setTimeout(finish, Math.max(Number(timeoutMs) || 30_000, 5_000))
    chrome.runtime.onMessage.addListener(handler)
  })
}

/** 后台标签等嗅探回包;超时带回页标题(供 Node 侧 CHALLENGE_RE 判定),收尾关自己的标签 */
function waitSniff(tabId, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false
    let title = ''
    const handler = (msg, sender) => {
      if (!sender || !sender.tab || sender.tab.id !== tabId) return
      if (msg && msg.type === 'gotry-page') { title = String(msg.title ?? title); return }
      if (msg && msg.type === 'gotry-sniff' && !settled) {
        settled = true
        clearTimeout(timer)
        chrome.runtime.onMessage.removeListener(handler)
        resolve({ ok: true, kind: 'search', body: String(msg.body ?? ''), url: String(msg.url ?? ''), title })
      }
    }
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      chrome.runtime.onMessage.removeListener(handler)
      resolve({ ok: false, kind: 'search', timeout: true, url: '', title })
    }, Math.max(Number(timeoutMs) || 30_000, 5_000))
    chrome.runtime.onMessage.addListener(handler)
  })
}

async function handleJob(job) {
  const jobId = job && job.jobId
  if (typeof jobId !== 'string' || !jobId) return
  const site = String((job && job.site) || '')
  const conf = SITES[site]
  try {
    if (!conf) {
      await postResult(jobId, { ok: false, error: `unknown site ${site}` })
      return
    }
    if (job.kind === 'cookie-names') {
      await postResult(jobId, { ok: true, kind: 'cookie-names', names: await ticketNames(site) })
      return
    }
    if (job.kind === 'open-login') {
      if (typeof job.url !== 'string' || !job.url.startsWith('https://')) {
        await postResult(jobId, { ok: false, error: 'open-login 需要 https job.url' })
        return
      }
      const tab = await chrome.tabs.create({ url: job.url, active: true })
      await postResult(jobId, { ok: true, kind: 'open-login', opened: true, tabId: tab.id })
      return
    }
    if (job.kind === 'search') {
      const allowedPrefix = SITE_SEARCH_PREFIXES[site]
      if (!allowedPrefix || typeof job.url !== 'string' || !job.url.startsWith(allowedPrefix)) {
        await postResult(jobId, { ok: false, error: `search 只允许 ${allowedPrefix ?? '已注册站点域'}(收到 ${String(job.url).slice(0, 80)})` })
        return
      }
      const tab = await chrome.tabs.create({ url: job.url, active: false })
      const result = job.multiCollect
        ? await waitSniffMulti(tab.id, job.timeoutMs)
        : await waitSniff(tab.id, job.timeoutMs)
      await chrome.tabs.remove(tab.id).catch(() => { /* 用户先关了,无妨 */ })
      await postResult(jobId, result)
      return
    }
    await postResult(jobId, { ok: false, error: `unknown job kind ${String(job.kind)}` })
  } catch (e) {
    await postResult(jobId, { ok: false, error: String(e && e.message ? e.message : e).slice(0, 200) })
  }
}

async function loop() {
  if (polling) return
  polling = true
  try {
    for (;;) {
      if (bridgeBase() == null) {
        const up = await detectBridge()
        if (!up) { await sleep(RETRY_MS); continue }
      }
      try {
        const r = await fetch(`${bridgeBase()}/jobs`, {
          method: 'POST',
          headers: bridgeHeaders(true),
          body: JSON.stringify({
            extensionVersion: chrome.runtime.getManifest().version,
            capabilities: Object.keys(SITES),
          }),
        })
        const data = await r.json().catch(() => ({ job: null }))
        if (data && data.job) await handleJob(data.job)
      } catch { activePort = null; await sleep(RETRY_MS) }
    }
  } finally {
    polling = false
  }
}

/**
 * portal content-bridge 派发入口(2026-09-11):hotel-be portal 在员工已登录的
 * 页面里通过 content-bridge.js 发 `gotry-join` 消息,SW 静默接收并缓存 ticket。
 * 员工从未看见这些消息;任何外部源都可发,但 ticket 必须由 hotel-be 后端签发,
 * Node 侧通过 Bearer 鉴权校验 ticket 内 token 才认账。
 */
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === 'gotry-join' && msg.ticket && typeof msg.ticket.bridgeUrl === 'string') {
    joinTicket = msg.ticket
    activePort = null
    sendResponse && sendResponse({ ok: true })
    return false
  }
  return false
})

// SW 冷启动 + 闹钟兜底双保险;loop() 幂等
if (chrome.runtime.onStartup) chrome.runtime.onStartup.addListener(() => { void loop() })
chrome.alarms.create('gotry-bridge-poll', { periodInMinutes: 0.5 })
chrome.alarms.onAlarm.addListener((a) => { if (a.name === 'gotry-bridge-poll') void loop() })
void loop()
