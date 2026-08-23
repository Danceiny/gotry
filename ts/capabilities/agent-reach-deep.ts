/**
 * agent-reach 深度能力层:yt-dlp 字幕提取 + gh 仓库搜索(可选工具,系统有就调,没有降级)。
 *
 * 与 agent-reach.ts(r.jina.ai 读网页)互补——dsh LLM 的 3 个 agent-reach 工具:
 *   - gotry_web_search      → r.jina.ai(已落,零配置)
 *   - gotry_video_subtitle  → yt-dlp(本文件;系统装了就调,没装降级提示安装方式)
 *   - gotry_github_search   → gh(本文件;系统装了就调,没装降级提示安装方式)
 *
 * 契约(与 anything/weather/opensky/agent-reach 同构,L4 不变量):
 *   - 永不抛错:spawn 失败/超时/工具未装一律降级返回;
 *   - 证据链标注:[agent-reach:yt-dlp@ts] / [agent-reach:gh@ts] / [@error@ts] / [@not-installed@ts];
 *   - 零强制依赖:不 npm install 任何东西,用系统 PATH 里的二进制。
 */

import { spawn } from 'node:child_process'

export interface SpawnQuery {
  /** 完整命令参数(不含 bin) */
  args: string[]
  /** 二进制名;默认按能力层定 */
  bin?: string
  /** 超时(ms);默认 30_000 */
  timeoutMs?: number
}

export interface SpawnResult {
  ok: boolean
  /** found / not-installed / error / timeout */
  verdict: 'found' | 'not-installed' | 'error' | 'timeout'
  evidence: string
  latencyMs: number
  stdout?: string
  stderr?: string
}

function run(bin: string, args: string[], timeoutMs: number): Promise<{ code: number | null; stdout: string; stderr: string; err?: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { env: process.env })
    let stdout = ''
    let stderr = ''
    let err: string | undefined
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      try { child.kill('SIGKILL') } catch { /* ignore */ }
    }, timeoutMs)
    child.stdout.on('data', (d: Buffer) => { stdout += d.toString() })
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString() })
    child.on('error', (e) => { err = (e as Error).message })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code, stdout, stderr, err, timedOut })
    })
  })
}

const ts = () => new Date().toISOString()

/** yt-dlp 提取视频字幕(YouTube/B站;系统需已装 yt-dlp) */
export async function videoSubtitle(q: { url: string; lang?: string; timeoutMs?: number }): Promise<SpawnResult & { subtitles?: string }> {
  const started = Date.now()
  const lang = q.lang ?? 'zh-Hans,zh,en'
  const args = ['--write-sub', '--write-auto-sub', '--sub-langs', lang, '--skip-download', '--sub-format', 'vtt', '-o', '/tmp/gotry-sub-%(id)s', q.url]
  const r = await run('yt-dlp', args, q.timeoutMs ?? 60_000)
  const latencyMs = Date.now() - started
  // not-installed: ENOENT
  if (r.err?.includes('ENOENT')) {
    return { ok: false, verdict: 'not-installed', evidence: `[agent-reach:yt-dlp@not-installed@${ts()}]`, latencyMs, stderr: 'yt-dlp 未安装;装法: brew install yt-dlp 或 pip install yt-dlp' }
  }
  if (r.timedOut) {
    return { ok: false, verdict: 'timeout', evidence: `[agent-reach:yt-dlp@error@${ts()}] timeout`, latencyMs }
  }
  if (r.code !== 0) {
    return { ok: false, verdict: 'error', evidence: `[agent-reach:yt-dlp@error@${ts()}] exit ${r.code}`, latencyMs, stderr: r.stderr.slice(0, 400) }
  }
  // 从 stdout 抓写入的字幕文件名
  const m = r.stdout.match(/Writing subtitles to:\s*(\S+)/)
  if (!m) {
    return { ok: false, verdict: 'error', evidence: `[agent-reach:yt-dlp@error@${ts()}] no subtitle file in output`, latencyMs, stderr: r.stdout.slice(0, 300) }
  }
  const { readFile } = await import('node:fs/promises')
  let subtitles: string | undefined
  try {
    subtitles = (await readFile(m[1]!, 'utf-8')).slice(0, 8000)
  } catch { /* 字幕文件读失败保留 undefined */ }
  return { ok: true, verdict: 'found', evidence: `[agent-reach:yt-dlp@${ts()}]`, latencyMs, stdout: r.stdout.slice(0, 400), subtitles }
}

/** gh 搜索 GitHub 仓库(系统需已装 gh 并登录) */
export async function githubSearch(q: { query: string; limit?: number; timeoutMs?: number }): Promise<SpawnResult & { repos?: Array<{ name: string; description?: string; stars?: number; url?: string }> }> {
  const started = Date.now()
  const limit = q.limit ?? 5
  const args = ['search', 'repos', q.query, '--json', 'fullName,description,stargazersCount,url', '--limit', String(limit)]
  const r = await run('gh', args, q.timeoutMs ?? 30_000)
  const latencyMs = Date.now() - started
  if (r.err?.includes('ENOENT')) {
    return { ok: false, verdict: 'not-installed', evidence: `[agent-reach:gh@not-installed@${ts()}]`, latencyMs, stderr: 'gh 未安装;装法: brew install gh && gh auth login' }
  }
  if (r.timedOut) {
    return { ok: false, verdict: 'timeout', evidence: `[agent-reach:gh@error@${ts()}] timeout`, latencyMs }
  }
  if (r.code !== 0) {
    return { ok: false, verdict: 'error', evidence: `[agent-reach:gh@error@${ts()}] exit ${r.code}`, latencyMs, stderr: r.stderr.slice(0, 300) }
  }
  try {
    const repos = JSON.parse(r.stdout) as Array<{ fullName: string; description?: string; stargazersCount?: number; url?: string }>
    return {
      ok: true, verdict: 'found', evidence: `[agent-reach:gh@${ts()}]`, latencyMs,
      repos: repos.map(x => ({ name: x.fullName, description: x.description, stars: x.stargazersCount, url: x.url })),
    }
  } catch {
    return { ok: false, verdict: 'error', evidence: `[agent-reach:gh@error@${ts()}] parse fail`, latencyMs, stderr: r.stdout.slice(0, 300) }
  }
}
