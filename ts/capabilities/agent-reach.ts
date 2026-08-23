/**
 * agent-reach 网页读取能力层(r.jina.ai 免 key):GoTry 的最小 web 搜索/读取兜底。
 *
 * 契约(与 anything/weather/opensky 同构,L4 不变量):
 *   - 永不抛错:网络失败/超时/解析失败一律降级返回;
 *   - 证据链标注:成功 [agent-reach:r.jina.ai@ts];失败 [agent-reach:r.jina.ai@error@ts];
 *   - 最小依赖:纯 fetch,零依赖,零 pip/npm 安装(用户已有 curl/fetch 即可)。
 *
 * 不是完整 agent-reach:仅网页读取 + Jina Reader;后续可扩展 mcporter exa 等。
 * D-4a B 选项的一部分。founder 拍板:接 agent-reach,但只接 r.jina.ai 这个零配置路径。
 *
 * 该文件与 gotry 的 dsh-llm/loop 不耦合——它是 dsh 插件调用的纯能力层,
 * 挂在 `gotry_web_search` dsh 工具后面。
 */

export interface AgentReachWebQuery {
  /** 待读的 URL(完整 http/https) */
  url: string
  /** 超时(ms);默认 20_000 */
  timeoutMs?: number
}

export interface AgentReachWebResult {
  ok: boolean
  via: 'r.jina.ai' | 'r.jina.ai-error'
  evidence: string
  latencyMs: number
  /** markdown 或纯文本(截 4000 字符) */
  content?: string
  /** URL 的最终标题/描述(若 Jina 响应里带) */
  title?: string
  error?: string
}

const JINA_BASE = 'https://r.jina.ai'

/** 读任意网页(markdown 化;Jina Reader 是免 key 的 markdown 化器) */
export async function readUrl(query: AgentReachWebQuery): Promise<AgentReachWebResult> {
  const started = Date.now()
  const ts = new Date().toISOString()
  const url = query.url.trim()
  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    return {
      ok: false,
      via: 'r.jina.ai-error',
      evidence: `[agent-reach:r.jina.ai@error@${ts}] URL 须以 http:// 或 https:// 开头`,
      latencyMs: Date.now() - started,
      error: 'invalid URL scheme',
    }
  }
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), query.timeoutMs ?? 20_000)
  try {
    const res = await fetch(`${JINA_BASE}/${url}`, {
      signal: ctrl.signal,
      headers: { Accept: 'text/markdown, text/plain, */*' },
    })
    clearTimeout(timer)
    if (!res.ok) {
      return {
        ok: false,
        via: 'r.jina.ai-error',
        evidence: `[agent-reach:r.jina.ai@error@${ts}] HTTP ${res.status}`,
        latencyMs: Date.now() - started,
        error: `HTTP ${res.status}`,
      }
    }
    const text = await res.text()
    const title = text.split('\n').find(l => l.startsWith('# '))?.replace(/^# /, '').slice(0, 120)
    return {
      ok: true,
      via: 'r.jina.ai',
      evidence: `[agent-reach:r.jina.ai@${ts}]`,
      latencyMs: Date.now() - started,
      content: text.slice(0, 4000),
      title,
    }
  } catch (e) {
    clearTimeout(timer)
    return {
      ok: false,
      via: 'r.jina.ai-error',
      evidence: `[agent-reach:r.jina.ai@error@${ts}]`,
      latencyMs: Date.now() - started,
      error: (e as Error).message.slice(0, 200),
    }
  }
}

/** 读任意 URL 但去掉 js 渲染部分(Jina 的 Reader 模式);可换 mcporter exa 作为 fallback */
export async function readUrlMarkdown(query: AgentReachWebQuery): Promise<AgentReachWebResult> {
  return readUrl(query)
}
