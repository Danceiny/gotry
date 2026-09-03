/**
 * GoTry Session Bridge — MV3 Service Worker(RFC user-session-data-rfc.md §2.2 通道 C,2026-08-29 定案为 PRIMARY 传输)。
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
}

/** 检索 URL 白名单(per-site;search job 只允许开各自站点域,其余一律拒) */
const SITE_SEARCH_PREFIXES = {
  'ctrip-flight': 'https://flights.ctrip.com/',
  'ctrip-hotel': 'https://hotels.ctrip.com/',
}

let activePort = null
let polling = false

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function detectPort() {
  for (const p of BRIDGE_PORTS) {
    try {
      const r = await fetch(`http://127.0.0.1:${p}/health`, { headers: { 'x-gotry-bridge': 'v1' } })
      if (r.ok) return p
    } catch { /* 无人监听,试下一个端口 */ }
  }
  return null
}

async function postResult(jobId, result) {
  if (activePort == null || !jobId) return
  try {
    await fetch(`http://127.0.0.1:${activePort}/results/${encodeURIComponent(jobId)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-gotry-bridge': 'v1' },
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
        resolve({ ok: true, kind: 'search', body: String(msg.body ?? ''), title })
      }
    }
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      chrome.runtime.onMessage.removeListener(handler)
      resolve({ ok: false, kind: 'search', timeout: true, title })
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
      const result = await waitSniff(tab.id, job.timeoutMs)
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
      if (activePort == null) activePort = await detectPort()
      if (activePort == null) { await sleep(RETRY_MS); continue }
      try {
        const r = await fetch(`http://127.0.0.1:${activePort}/jobs`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-gotry-bridge': 'v1' },
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

// SW 冷启动 + 闹钟兜底双保险;loop() 幂等
if (chrome.runtime.onStartup) chrome.runtime.onStartup.addListener(() => { void loop() })
chrome.alarms.create('gotry-bridge-poll', { periodInMinutes: 0.5 })
chrome.alarms.onAlarm.addListener((a) => { if (a.name === 'gotry-bridge-poll') void loop() })
void loop()