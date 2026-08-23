/**
 * agent-reach 渠道统一能力层 —— 100% follow Panniantong/Agent-Reach 的路由表。
 *
 * agent-reach 仓(Panniantong/Agent-Reach, MIT)的架构: installer + doctor + 路由知识(SKILL.md)。
 * 实际读取由上游工具完成(r.jina.ai / yt-dlp / gh / mcporter / bili / rdt / feedparser / OpenCLI)。
 * 本文件把 SKILL.md 的路由表翻译成 gotry 的能力层:
 *
 *   渠道路由(与 SKILL.md 路由表一一对应):
 *   - web      → r.jina.ai(fetch, 零配置)               [已实现 readUrl]
 *   - rss      → 纯 fetch + XML 解析(零配置)             [本文件 rssFeed]
 *   - v2ex     → https://www.v2ex.com/api/topics/hot.json(零配置) [本文件 v2exHot]
 *   - youtube  → yt-dlp 字幕(可选 spawn)                [agent-reach-deep.ts videoSubtitle]
 *   - github   → gh CLI(可选 spawn)                    [agent-reach-deep.ts githubSearch]
 *   - bilibili → bili-cli(可选 spawn)                  [本文件 bilibiliSearch]
 *   - exa      → mcporter exa(可选 spawn, MCP)          [本文件 exaSearch]
 *   - twitter / reddit / xhs / facebook / instagram / linkedin / xiaoyuzhou / xueqiu
 *             → 需登录态/Cookie,降级为 setup 指引(agent-reach guides) [本文件 needsSetup]
 *
 *   doctor 体检:
 *   - agentReachStatus(): 若 agent-reach CLI(>=3.10 venv)在 → spawn `agent-reach doctor`
 *     不在 → 自探测零配置渠道(web/rss/v2ex)+ 可选渠道(yt-dlp/gh/bili/mcporter)
 *
 * 契约(L4 不变量,与 anything/weather/opensky 同构):
 *   - 永不抛错;三值(found / not-installed / needs-setup);证据链 [agent-reach:<chan>@ts]。
 */

import { spawn } from 'node:child_process'
import { videoSubtitle, githubSearch } from './agent-reach-deep.ts'

export type ReachChannel =
  | 'web' | 'rss' | 'v2ex'
  | 'youtube' | 'github' | 'bilibili' | 'exa'
  | 'twitter' | 'reddit' | 'xhs' | 'facebook' | 'instagram' | 'linkedin' | 'xiaoyuzhou' | 'xueqiu'

export interface ReachResult {
  channel: ReachChannel
  ok: boolean
  verdict: 'found' | 'not-installed' | 'needs-setup' | 'error'
  evidence: string
  latencyMs: number
  data?: unknown
  setup?: string
  error?: string
}

const ts = () => new Date().toISOString()
const base = (ch: ReachChannel): Pick<ReachResult, 'channel'> => ({ channel: ch })

function run(bin: string, args: string[], timeoutMs: number): Promise<{ code: number | null; stdout: string; stderr: string; err?: string }> {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { env: process.env })
    let stdout = ''
    let stderr = ''
    let err: string | undefined
    const timer = setTimeout(() => { try { child.kill('SIGKILL') } catch { /* ignore */ } }, timeoutMs)
    child.stdout.on('data', (d: Buffer) => { stdout += d.toString() })
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString() })
    child.on('error', (e) => { err = (e as Error).message })
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr, err }) })
  })
}

async function fetchText(url: string, timeoutMs: number, accept: string): Promise<{ ok: boolean; text?: string; status?: number; error?: string }> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { Accept: accept, 'User-Agent': 'gotry/0.0.1-rc (+agent-reach follow)' } })
    if (!res.ok) return { ok: false, status: res.status }
    return { ok: true, text: await res.text(), status: res.status }
  } catch (e) {
    return { ok: false, error: (e as Error).message.slice(0, 200) }
  } finally {
    clearTimeout(timer)
  }
}

// ---- RSS(零配置,纯 XML 抽取) ------------------------------------------------

export interface RssItem { title?: string; link?: string; date?: string }

export async function rssFeed(url: string, timeoutMs = 15_000): Promise<ReachResult & { items?: RssItem[] }> {
  const started = Date.now()
  const r = await fetchText(url, timeoutMs, 'application/rss+xml, application/atom+xml, application/xml, */*')
  if (!r.ok || !r.text) {
    return { ...base('rss'), ok: false, verdict: 'error', evidence: `[agent-reach:rss@error@${ts()}] ${r.error ?? `HTTP ${r.status}`}`, latencyMs: Date.now() - started, error: r.error ?? `HTTP ${r.status}` }
  }
  const items: RssItem[] = []
  // RSS <item> 与 Atom <entry> 都吃;title/link/pubDate|updated 抽取
  const blocks = r.text.match(/<(?:item|entry)[\s\S]*?<\/(?:item|entry)>/g) ?? []
  for (const b of blocks.slice(0, 20)) {
    const pick = (re: RegExp) => b.match(re)?.[1]?.trim()
    items.push({
      title: pick(/<title[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/),
      link: pick(/<link[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/link>/) ?? pick(/<link[^>]*href="([^"]+)"/),
      date: pick(/<pubDate[^>]*>([\s\S]*?)<\/pubDate>/) ?? pick(/<updated[^>]*>([\s\S]*?)<\/updated>/),
    })
  }
  return { ...base('rss'), ok: true, verdict: 'found', evidence: `[agent-reach:rss@${ts()}] ${items.length} items`, latencyMs: Date.now() - started, items }
}

// ---- V2EX(零配置 API) --------------------------------------------------------

export async function v2exHot(timeoutMs = 15_000): Promise<ReachResult & { topics?: Array<{ title?: string; url?: string; replies?: number }> }> {
  const started = Date.now()
  const r = await fetchText('https://www.v2ex.com/api/topics/hot.json', timeoutMs, 'application/json')
  if (!r.ok || !r.text) {
    return { ...base('v2ex'), ok: false, verdict: 'error', evidence: `[agent-reach:v2ex@error@${ts()}] ${r.error ?? `HTTP ${r.status}`}`, latencyMs: Date.now() - started, error: r.error ?? `HTTP ${r.status}` }
  }
  try {
    const arr = JSON.parse(r.text) as Array<{ title?: string; url?: string; replies?: number }>
    const topics = arr.slice(0, 20).map(t => ({ title: t.title, url: t.url, replies: t.replies }))
    return { ...base('v2ex'), ok: true, verdict: 'found', evidence: `[agent-reach:v2ex@${ts()}] ${topics.length} topics`, latencyMs: Date.now() - started, topics }
  } catch (e) {
    return { ...base('v2ex'), ok: false, verdict: 'error', evidence: `[agent-reach:v2ex@error@${ts()}] parse`, latencyMs: Date.now() - started, error: (e as Error).message.slice(0, 120) }
  }
}

// ---- Bilibili(bili-cli,可选) ------------------------------------------------

export async function bilibiliSearch(keyword: string, timeoutMs = 30_000): Promise<ReachResult & { results?: unknown }> {
  const started = Date.now()
  const r = await run('bili', ['search', keyword], timeoutMs)
  if (r.err?.includes('ENOENT')) {
    return { ...base('bilibili'), ok: false, verdict: 'not-installed', evidence: `[agent-reach:bilibili@not-installed@${ts()}]`, latencyMs: Date.now() - started, setup: 'npm install -g bili-cli 或参考 agent-reach 的 bilibili 渠道' }
  }
  if (r.code !== 0) {
    return { ...base('bilibili'), ok: false, verdict: 'error', evidence: `[agent-reach:bilibili@error@${ts()}] exit ${r.code}`, latencyMs: Date.now() - started, error: r.stderr.slice(0, 200) }
  }
  return { ...base('bilibili'), ok: true, verdict: 'found', evidence: `[agent-reach:bilibili@${ts()}]`, latencyMs: Date.now() - started, results: r.stdout.slice(0, 4000) }
}

// ---- Exa(mcporter MCP,可选) --------------------------------------------------

export async function exaSearch(query: string, numResults = 5, timeoutMs = 30_000): Promise<ReachResult & { results?: unknown }> {
  const started = Date.now()
  const r = await run('mcporter', [`call exa.web_search_exa(query: "${query.replace(/"/g, '\\"')}", numResults: ${numResults})`], timeoutMs)
  if (r.err?.includes('ENOENT')) {
    return { ...base('exa'), ok: false, verdict: 'not-installed', evidence: `[agent-reach:exa@not-installed@${ts()}]`, latencyMs: Date.now() - started, setup: 'mcporter 未装;参考 agent-reach guides/setup-exa.md(免费无需 Key)' }
  }
  if (r.code !== 0) {
    return { ...base('exa'), ok: false, verdict: 'error', evidence: `[agent-reach:exa@error@${ts()}] exit ${r.code}`, latencyMs: Date.now() - started, error: r.stderr.slice(0, 200) }
  }
  return { ...base('exa'), ok: true, verdict: 'found', evidence: `[agent-reach:exa@${ts()}]`, latencyMs: Date.now() - started, results: r.stdout.slice(0, 4000) }
}

// ---- 需登录态的渠道(SKILL.md: 配置后解锁) ------------------------------------

const SETUP_GUIDES: Partial<Record<ReachChannel, string>> = {
  twitter: '告诉 Agent「帮我配 Twitter」:Cookie-Editor 导出 → agent-reach configure twitter-cookies(agent-reach guides/setup-twitter.md)',
  reddit: '桌面装 OpenCLI 用浏览器登录态;或 rdt-cli + Cookie(agent-reach guides/setup-reddit.md)',
  xhs: 'OpenCLI(用户已有 Chrome 会话)或 Cookie-Editor 导出后配 xiaohongshu-mcp(agent-reach guides/setup-xiaohongshu.md;agent-reach 不替用户登录)',
  facebook: '桌面装 OpenCLI(复用 Chrome 登录态)',
  instagram: '桌面装 OpenCLI(复用 Chrome 登录态)',
  linkedin: '公开页可直接走 web 渠道(r.jina.ai);Profile 详情需 OpenCLI',
  xueqiu: '告诉 Agent「帮我配雪球」',
  xiaoyuzhou: 'Whisper 免费 Key(agent-reach 渠道表: 播客转文字)',
}

export function needsSetup(channel: ReachChannel): ReachResult {
  return {
    channel, ok: false, verdict: 'needs-setup',
    evidence: `[agent-reach:${channel}@needs-setup@${ts()}]`,
    latencyMs: 0,
    setup: SETUP_GUIDES[channel] ?? `渠道 ${channel} 需登录态;参考 agent-reach SKILL.md / guides/`,
  }
}

// ---- doctor 体检 ---------------------------------------------------------------

export interface ReachStatus {
  ok: boolean
  via: 'agent-reach-cli' | 'gotry-probe'
  evidence: string
  latencyMs: number
  channels: Array<{ channel: ReachChannel; state: string; note?: string }>
}

/** 渠道体检:优先 spawn 真正的 agent-reach doctor(.venv/bin/agent-reach v1.5.0);没有则 gotry 自探测 */
export async function reachStatus(timeoutMs = 60_000): Promise<ReachStatus> {
  const started = Date.now()
  // 1) 真正的 agent-reach CLI(gotry .venv/bin/agent-reach v1.5.0;100% follow 上游 doctor)
  const { existsSync } = await import('node:fs')
  const { resolve } = await import('node:path')
  // repo root = ts/capabilities 的上两级;兼容从 ts/ 或仓根运行
  const root = resolve(import.meta.dirname, '..', '..')
  const binCandidates = [resolve(root, '.venv/bin/agent-reach'), 'agent-reach'].filter(b => b.includes('/') ? existsSync(b) : true)
  for (const bin of binCandidates) {
    const r = await run(bin, ['doctor'], timeoutMs)
    if (!r.err?.includes('ENOENT')) {
      return {
        ok: true, via: 'agent-reach-cli',
        evidence: `[agent-reach:doctor@${ts()}] via ${bin}`,
        latencyMs: Date.now() - started,
        channels: [{ channel: 'web', state: 'see-doctor-output', note: (r.stdout || r.stderr).slice(0, 2000) }],
      }
    }
  }
  // 2) gotry 自探测(零配置 + 可选二进制存在性)
  const which = async (b: string) => (await run(b, ['--version'], 3000)).err?.includes('ENOENT') ? 'absent' : 'present'
  const [yt, gh, bili, mcporter] = await Promise.all([which('yt-dlp'), which('gh'), which('bili'), which('mcporter')])
  return {
    ok: true, via: 'gotry-probe',
    evidence: `[agent-reach:probe@${ts()}]`,
    latencyMs: Date.now() - started,
    channels: [
      { channel: 'web', state: 'ready' },
      { channel: 'rss', state: 'ready' },
      { channel: 'v2ex', state: 'ready' },
      { channel: 'youtube', state: yt, note: yt === 'present' ? undefined : 'brew install yt-dlp' },
      { channel: 'github', state: gh, note: gh === 'present' ? undefined : 'brew install gh && gh auth login' },
      { channel: 'bilibili', state: bili, note: bili === 'present' ? undefined : 'bili-cli 可选' },
      { channel: 'exa', state: mcporter, note: mcporter === 'present' ? undefined : 'mcporter 可选(setup-exa.md 免费)' },
      { channel: 'twitter', state: 'needs-setup' },
      { channel: 'reddit', state: 'needs-setup' },
      { channel: 'xhs', state: 'needs-setup' },
      { channel: 'facebook', state: 'needs-setup' },
      { channel: 'instagram', state: 'needs-setup' },
      { channel: 'linkedin', state: 'partial', note: '公开页走 web 渠道' },
      { channel: 'xiaoyuzhou', state: 'needs-setup' },
      { channel: 'xueqiu', state: 'needs-setup' },
    ],
  }
}

// ---- 统一入口:SKILL.md 路由表的代码化 ------------------------------------------

export interface ReachQuery {
  channel: ReachChannel
  /** web/rss: URL;bilibili/exa: 关键词;youtube: 视频 URL;github: 搜索词;v2ex: 无参 */
  arg?: string
  timeoutMs?: number
}

/** 按渠道路由(100% follow SKILL.md 的路由表);永不抛错 */
export async function reach(q: ReachQuery): Promise<ReachResult> {
  switch (q.channel) {
    case 'web': {
      const { readUrl } = await import('./agent-reach.ts')
      const r = await readUrl({ url: q.arg ?? '', timeoutMs: q.timeoutMs })
      return { ...base('web'), ok: r.ok, verdict: r.ok ? 'found' : 'error', evidence: r.evidence, latencyMs: r.latencyMs, data: { title: r.title, content: r.content?.slice(0, 2000) }, error: r.error }
    }
    case 'rss':
      return rssFeed(q.arg ?? '')
    case 'v2ex':
      return v2exHot(q.timeoutMs)
    case 'youtube': {
      const r = await videoSubtitle({ url: q.arg ?? '', timeoutMs: q.timeoutMs })
      return { ...base('youtube'), ok: r.ok, verdict: r.verdict === 'found' ? 'found' : (r.verdict === 'not-installed' ? 'not-installed' : 'error'), evidence: r.evidence, latencyMs: r.latencyMs, data: r.subtitles?.slice(0, 3000), setup: r.verdict === 'not-installed' ? r.stderr : undefined }
    }
    case 'github': {
      const r = await githubSearch({ query: q.arg ?? '', timeoutMs: q.timeoutMs })
      return { ...base('github'), ok: r.ok, verdict: r.verdict === 'found' ? 'found' : (r.verdict === 'not-installed' ? 'not-installed' : 'error'), evidence: r.evidence, latencyMs: r.latencyMs, data: r.repos, setup: r.verdict === 'not-installed' ? r.stderr : undefined }
    }
    case 'bilibili':
      return bilibiliSearch(q.arg ?? '', q.timeoutMs)
    case 'exa':
      return exaSearch(q.arg ?? '', 5, q.timeoutMs)
    default:
      return needsSetup(q.channel)
  }
}
