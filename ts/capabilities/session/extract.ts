/**
 * a11y 快照兜底抽取器(RFC §2.3 第②层:站点无干净 XHR JSON 时,从可访问性树快照抽结构化条目)。
 * 纯函数:输入 Playwright ariaSnapshot/domSnapshot 文本,输出归一化条目(role/name/ref),
 * 供确定性规则或 LLM 按 schema 消费;不做任何页面交互。
 *
 * 辑律(ADR-12 同款边界):抽取只认结构(行首 role 与缩进),不做开放式语义猜测;
 * 页面文本是不可信输入(RFC §3.5)——本层只归形状,语义判定在上游 schema 处。
 */

export interface A11yEntry {
  /** 行首 role,如 button / textbox / link / heading / listitem */
  role: string
  /** 括号内 accessible name(去引号,截断 200) */
  name: string
  /** 快照行号(0 基,回指原快照) */
  line: number
}

/**
 * Playwright aria snapshot 行形如:
 *   `- button "搜索" [ref=s1e5]`
 *   `- heading "上海到丽江" [level=1]`
 * 提取 role/name;无 name 的行(name='')保留占位(计数/结构比对仍可用)。
 */
export function extractA11yEntries(snapshotText: string, opts: { maxEntries?: number } = {}): A11yEntry[] {
  const cap = opts.maxEntries ?? 500
  const out: A11yEntry[] = []
  const lines = snapshotText.split('\n')
  for (let i = 0; i < lines.length && out.length < cap; i++) {
    const m = /^[\s*-]*\s*([a-zA-Z][\w-]*)(?:\s+"((?:[^"\\]|\\.)*)")?/.exec(lines[i] ?? '')
    if (!m) continue
    const name = (m[2] ?? '').replace(/\\"/g, '"').slice(0, 200)
    out.push({ role: m[1]!.toLowerCase(), name, line: i })
  }
  return out
}

/** DOM 提交件过滤入口(RFC §3.3-②):从条目集中剔除命中提交黑名单的可交互件,返回保留集 */
export function filterSubmitEntries<T extends { role: string; name: string }>(entries: T[], isSubmit: (name: string) => boolean): T[] {
  const interactive = new Set(['button', 'link', 'menuitem', 'option'])
  return entries.filter((e) => !(interactive.has(e.role) && isSubmit(e.name)))
}

/** 名称相似度粗筛(自愈定位的候选排序底座;0=不同串,1=包含) */
export function nameAffinity(a: string, b: string): number {
  const x = a.trim(); const y = b.trim()
  if (!x || !y) return 0
  if (x === y) return 1
  if (x.includes(y) || y.includes(x)) return 0.8
  const sa = new Set(x); const sb = new Set(y)
  let common = 0
  for (const ch of sa) if (sb.has(ch)) common += 1
  return common / Math.max(sa.size, sb.size)
}
