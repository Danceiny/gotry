/**
 * agent-reach wrapper —— 上游 Panniantong/Agent-Reach 的薄壳(零渠道知识)。
 *
 * 分工(2026-08-22 founder 纠偏「wrapper 不是 router」):
 *   - 知识(渠道清单/方法签名/setup 指引)→ 上游:agent_reach.channels 注册表 + Channel.check() + guides/
 *   - 决策(该调哪个渠道哪个方法)      → dsh 里的 LLM(靠本 wrapper 的自描述错误拿清单)
 *   - 管道(spawn/超时/永不抛错/证据链) → 本文件 + agent-reach-bridge.py,上游加渠道零改动
 *
 * 上游设计意图(Channel 基类原话):"After installation, agents call upstream tools directly."
 *   - python-API 渠道(web.read / v2ex.get_hot_topics / xueqiu.get_stock_quote / youtube.transcribe ...)
 *     走本文件 reach() 的反射桥
 *   - 外部 CLI 工具渠道(github→gh / youtube 字幕→yt-dlp 等)由专用 dsh 工具(gotry_github_search /
 *     gotry_video_subtitle,见 agent-reach-deep.ts)充当执行面;上游无 python API 的不再自行拼命令
 *
 * 契约(L4 不变量,与 anything/weather/opensky 同构):
 *   - 永不抛错;verdict: found / not-installed / needs-setup / error
 *   - needs-setup 的 setup 文案 = 上游 check() 原话透传,不转述
 *   - 证据链 [agent-reach:<channel>.<method>@ts]
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

export interface ReachResult {
  channel: string
  method: string
  ok: boolean
  verdict: 'found' | 'not-installed' | 'needs-setup' | 'error'
  evidence: string
  latencyMs: number
  data?: unknown
  /** 上游清单(未知渠道→渠道表;未知方法→方法签名表),LLM 据此自纠 */
  inventory?: Record<string, unknown>
  /** 上游 check() 原话(仅 needs-setup 时) */
  setup?: string
  error?: string
}

const ts = () => new Date().toISOString()
const repoRoot = () => resolve(import.meta.dirname, '..', '..')
const venvPython = () => resolve(repoRoot(), '.venv/bin/python')
const bridgeScript = () => resolve(import.meta.dirname, 'agent-reach-bridge.py')

function run(bin: string, args: string[], timeoutMs: number): Promise<{ code: number | null; stdout: string; stderr: string; err?: string }> {
  return new Promise((resolveRun) => {
    const child = spawn(bin, args, { env: process.env })
    let stdout = ''
    let stderr = ''
    let err: string | undefined
    const timer = setTimeout(() => { try { child.kill('SIGKILL') } catch { /* ignore */ } }, timeoutMs)
    child.stdout.on('data', (d: Buffer) => { stdout += d.toString() })
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString() })
    child.on('error', (e) => { err = (e as Error).message })
    child.on('close', (code) => { clearTimeout(timer); resolveRun({ code, stdout, stderr, err }) })
  })
}

interface BridgeOut {
  ok?: boolean
  data?: unknown
  error?: string
  check?: { status?: string; message?: string }
  channels?: Record<string, string>
  methods?: Record<string, string>
  channel?: Record<string, unknown>
}

/** 通用入口:反射调上游任意渠道方法;永不抛错 */
export async function reach(q: { channel: string; method: string; args?: string[] | string; timeoutMs?: number }): Promise<ReachResult> {
  const started = Date.now()
  const evidence = (state: string) => `[agent-reach:${q.channel}.${q.method}@${state === 'found' ? ts() : `${state}@${ts()}`}]`
  const base = { channel: q.channel, method: q.method }

  if (!q.channel || !q.method) {
    return { ...base, ok: false, verdict: 'error', evidence: evidence('error'), latencyMs: 0, error: 'channel 与 method 必填(渠道/方法清单:先随便调一次,inventory 会带回上游清单)' }
  }
  const py = venvPython()
  if (!existsSync(py)) {
    return { ...base, ok: false, verdict: 'not-installed', evidence: evidence('not-installed'), latencyMs: 0, setup: 'gotry .venv 缺 python — 见 docs/tokens.md(agent-reach 安装)' }
  }
  const args = Array.isArray(q.args) ? q.args : (q.args ? q.args.split(/\s+/).filter(Boolean) : [])
  const r = await run(py, [bridgeScript(), q.channel, q.method, ...args], q.timeoutMs ?? 30_000)
  const latencyMs = Date.now() - started

  let parsed: BridgeOut = {}
  try {
    parsed = JSON.parse((r.stdout || '').trim().split('\n').filter(Boolean).pop() ?? '{}') as BridgeOut
  } catch { /* 走下面的兜底 */ }

  if (r.err?.includes('ENOENT')) {
    return { ...base, ok: false, verdict: 'not-installed', evidence: evidence('not-installed'), latencyMs, setup: '.venv/bin/python 不可执行(装 agent-reach: 见 docs/tokens.md)' }
  }
  if (parsed.ok === true) {
    return { ...base, ok: true, verdict: 'found', evidence: evidence('found'), latencyMs, data: parsed.data }
  }
  // 上游 agent_reach 包未装(bridge 自己的 exit 3 输出)
  if (parsed.error?.includes('agent_reach 未安装')) {
    return { ...base, ok: false, verdict: 'not-installed', evidence: evidence('not-installed'), latencyMs, setup: '.venv 缺 agent-reach(pip install agent-reach,见 docs/tokens.md)' }
  }
  // 未知渠道/方法:自描述,附上游清单(不拦 LLM,让它看清单自纠)
  if (r.code === 2) {
    return {
      ...base, ok: false, verdict: 'error', evidence: evidence('error'), latencyMs,
      error: parsed.error,
      inventory: parsed.channels ? { channels: parsed.channels } : { channel: parsed.channel, methods: parsed.methods },
    }
  }
  // 调用抛错:若上游 check() 给出 warn/off,把上游原话作为 setup 透传
  const checkStatus = parsed.check?.status
  if (checkStatus === 'warn' || checkStatus === 'off') {
    return { ...base, ok: false, verdict: 'needs-setup', evidence: evidence('needs-setup'), latencyMs, error: parsed.error, setup: parsed.check?.message }
  }
  return { ...base, ok: false, verdict: 'error', evidence: evidence('error'), latencyMs, error: parsed.error ?? r.stderr.slice(0, 200) }
}

/** 读网页:委托上游 WebChannel.read(Jina Reader 后端);供 gotry web 读取工具使用 */
export async function readUrl(q: { url: string; timeoutMs?: number }): Promise<{ ok: boolean; via: string; title?: string; content?: string; evidence: string; latencyMs: number; error?: string }> {
  if (!/^https?:\/\//.test(q.url.trim())) {
    return { ok: false, via: 'r.jina.ai-error', evidence: `[agent-reach:web.read@error@${ts()}] 非法 URL(需 http(s)://)`, latencyMs: 0, error: 'url 必须以 http(s):// 开头' }
  }
  const r = await reach({ channel: 'web', method: 'read', args: [q.url.trim()], timeoutMs: q.timeoutMs })
  const content = typeof r.data === 'string' ? r.data.slice(0, 8000) : undefined
  // 上游 Jina Reader 输出首行 "Title: ...",提取为标题(展示层逻辑,非渠道知识)
  const title = content?.match(/^Title: (.+)$/m)?.[1]
  return {
    ok: r.ok, via: r.ok ? 'r.jina.ai' : 'r.jina.ai-error',
    title, content, evidence: r.evidence, latencyMs: r.latencyMs,
    error: r.error,
  }
}

export interface ReachStatus {
  ok: boolean
  via: 'agent-reach-cli' | 'not-installed'
  evidence: string
  latencyMs: number
  /** 上游 doctor 原始输出(渠道状态以上游为准,gotry 不自探测) */
  output: string
}

/** 渠道体检:spawn 真 agent-reach doctor,输出原样透传 */
export async function reachStatus(timeoutMs = 90_000): Promise<ReachStatus> {
  const started = Date.now()
  const bin = resolve(repoRoot(), '.venv/bin/agent-reach')
  if (!existsSync(bin)) {
    return { ok: false, via: 'not-installed', evidence: `[agent-reach:doctor@not-installed@${ts()}]`, latencyMs: 0, output: 'pip install agent-reach 于 .venv(见 docs/tokens.md)' }
  }
  const r = await run(bin, ['doctor'], timeoutMs)
  const output = (r.stdout || r.stderr).trim()
  return {
    ok: !r.err?.includes('ENOENT') && r.code === 0,
    via: 'agent-reach-cli',
    evidence: `[agent-reach:doctor@${ts()}] via .venv/bin/agent-reach`,
    latencyMs: Date.now() - started,
    output: output.slice(0, 4000),
  }
}
