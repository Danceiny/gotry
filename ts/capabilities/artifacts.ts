/**
 * 产物面(issue #25):agent 生成的文件不再只是「落在本地文件系统里的一个文件名」。
 *
 * 只读能力层,两个纯函数入口(dsh 工具 gotry_artifacts_list / gotry_artifacts_read 的实现):
 *   - listArtifacts: 产物发现。权威源 = 账本 workflow_runs(ADR-15;无账本的旧 root 回退
 *     扫描 gotry-state/async/*.deliverable.md 文件视图),外加 dsh 工作目录顶层 *.md
 *     (agent 写出的行程/规划文件正落在这里——issue 截图里的 trip-2027-*.md 即此类)
 *     与顶层 *.html/*.htm(issue #441:行程 HTML 产物需先能被发现)。
 *     分页/搜索语义(issue #458):offset(零-based 非负整数)与 search(字面 case-insensitive
 *     子串,匹配 id/title/filename,trim 后空串=不过滤)是先收集全部合格元数据 → 路径 dedupe →
 *     搜索过滤 → updated DESC + (source,id,canonical path) 词典序 tie-break → 按
 *     pageSize 切片的全局模型;pageSize 默认 20、上限 50;nextOffset 仅当
 *     offset + returned < total;offset 越界返回空数组 + 准确 total + truncated:false +
 *     无 nextOffset;total 反映已过滤集合的真实长度,不假装文件系统快照稳定。
 *   - readArtifact: 产物阅读。行窗口(offset/limit)+ 原始行号,输出 dsh read 卡所需的
 *     全部字段({number,text}[] / totalLines / lang),UI 侧渲染为行号文件视图。
 *
 * 纪律:本层只读(不写任何文件;WriteGate 红线不涉及);读取范围白名单 =
 * stateRoot 根 + dsh 工作目录(排除 node_modules/.git),扩展名白名单 =
 * 文本类(md/txt/json/jsonl/csv/log/yaml/yml/html/htm)——本工具是「产物查看」,
 * 不是通用文件浏览器。HTML 在本层只作源码文本读取:不解析标记、不运行脚本/内联事件、
 * 不发起抓取;列表项的主动打开走宿主原生 HTML 预览(客户端以 Open HTML preview 标注
 * 并提示页面脚本可能运行,属宿主 renderer 行为),交互式 Lavish 本地编辑反馈归 #438/#443。
 */

import { createHash } from 'node:crypto'
import { readdir, readFile, realpath, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { isAbsolute, join, resolve, sep } from 'node:path'

import { openLedgerIfExists } from '../src/state-ledger.ts'

export interface ArtifactEntry {
  source: 'async-run' | 'cwd-file'
  id: string
  title: string
  path: string
  status?: string
  updated?: string
  bytes?: number
}

export interface ArtifactReadView {
  ok: true
  source: 'state-root' | 'cwd'
  path: string
  offset: number
  lines: Array<{ number: number; text: string }>
  totalLines: number
  lang?: string
  /** Short content fingerprint shown by the Web Client to distinguish refreshes. */
  version: string
  content: string
  windowed: boolean
}

export interface ListArtifactsOptions {
  stateRoot: string
  cwd?: string
  limit?: number
  /** Zero-based nonnegative integer; values outside the eligible set return an empty page with the known total. */
  offset?: number
  /** Literal, case-insensitive substring over `id` / `title` / filename. Empty / whitespace-only = no filter. */
  search?: string
}

export interface ListArtifactsResult {
  artifacts: ArtifactEntry[]
  total: number
  truncated: boolean
  /** Present only when a subsequent page exists (`offset + artifacts.length < total`). */
  nextOffset?: number
  /** Echo of the effective limit so callers can verify clamping. */
  limit: number
  /** Echo of the effective offset (always present for the model-visible output, even when zero). */
  offset: number
  /** Echo of the trimmed search filter; absent when no filter was applied. */
  search?: string
  roots: string[]
}

const MAX_LIST = 50
const DEFAULT_LIST = 20
const MAX_WINDOW = 400
const MAX_BYTES = 2 * 1024 * 1024
const TEXT_EXT_LANG: Record<string, string> = {
  md: 'markdown', txt: 'text', json: 'json', jsonl: 'json', csv: 'csv', log: 'text', yaml: 'yaml', yml: 'yaml',
  html: 'html', htm: 'html',
}
/** 工作目录顶层可发现的产物扩展名(大小写不敏感);html/htm 只作源码预览。 */
const CWD_DISCOVER_EXT = /\.(md|html|htm)$/i
const DIR_DENY = ['node_modules', '.git']

/**
 * Validate a nonnegative-integer pagination knob (`offset`). undefined defaults
 * to 0; finite, integer, ≥0 numbers pass through; null / strings / nonfinite
 * / noninteger values fail closed rather than being silently coerced.
 */
function normalizeOffset(value: unknown, label: string): number {
  if (value === undefined) return 0
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value) || value < 0) {
    throw new Error(`${label} must be a nonnegative integer`)
  }
  return value
}

/**
 * Validate and clamp a page-size knob (`limit`). Integer-shaped numbers
 * (including zero / negative, to keep the pre-#458 clamp-on-1 contract) clamp
 * to [1, MAX_LIST]; strings, nonfinite, and noninteger values fail closed
 * without silent coercion. undefined defaults to DEFAULT_LIST.
 */
function clampLimit(value: unknown): number {
  if (value === undefined) return DEFAULT_LIST
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value)) {
    throw new Error(`limit must be a positive integer`)
  }
  return Math.max(1, Math.min(value, MAX_LIST))
}

/**
 * Validate the optional `search` filter. Strings trim; empty / whitespace-only
 * means no filter (already documented). Anything other than a string fails
 * closed rather than passing through as a silent "no filter".
 */
function normalizeSearch(value: unknown): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string') throw new Error(`search must be a string`)
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

function rootOf(stateRoot: string): string {
  return stateRoot === '.' ? process.cwd() : resolve(stateRoot)
}

function underRoot(p: string, root: string): boolean {
  const r = resolve(root)
  return p === r || p.startsWith(r + sep)
}

function hasDeniedSegment(p: string): boolean {
  return p.split(sep).some(seg => DIR_DENY.includes(seg))
}

function asyncDeliverablePath(root: string, id: string): string {
  return join(root, 'gotry-state', 'async', `${id}.deliverable.md`)
}

/**
 * Stable sort key for a list row. Order: `updated` DESC (ISO strings sort
 * lexicographically), then `source` ASC, then `id` ASC, then canonical `path`
 * ASC. The deterministic tie-break matters when many entries share an
 * `updated` value (e.g. equal mtime): pagination would otherwise emit the
 * same id on two adjacent pages. All comparisons are pure codepoint order
 * (no `localeCompare`) so the order is stable across hosts/locales.
 */
function compareArtifacts(a: ArtifactEntry, b: ArtifactEntry): number {
  const updA = String(a.updated ?? '')
  const updB = String(b.updated ?? '')
  if (updA !== updB) return updA < updB ? 1 : -1
  if (a.source !== b.source) return a.source < b.source ? -1 : 1
  if (a.id !== b.id) return a.id < b.id ? -1 : 1
  return a.path < b.path ? -1 : a.path > b.path ? 1 : 0
}

function filenameOf(entry: ArtifactEntry): string {
  const lastSep = entry.path.lastIndexOf(sep)
  return lastSep >= 0 ? entry.path.slice(lastSep + 1) : entry.path
}

/** Literal substring predicate (case-insensitive) over id/title/filename. */
function matchesSearch(entry: ArtifactEntry, needle: string): boolean {
  const lower = needle.toLowerCase()
  return entry.id.toLowerCase().includes(lower)
    || entry.title.toLowerCase().includes(lower)
    || filenameOf(entry).toLowerCase().includes(lower)
}

/** 账本 workflow_runs 是权威(listWorkflowRuns 只读 SELECT 直查,不为一个视图改 ledger 类)。 */
function listRunsFromLedger(root: string, tenant: string): ArtifactEntry[] {
  const ledger = openLedgerIfExists(root, tenant)
  if (!ledger) return []
  const rows = ledger.db
    .prepare('SELECT id, goal, status, deliverable, updated FROM workflow_runs WHERE tenant_id = ? ORDER BY updated DESC')
    .all(ledger.tenant) as Array<{ id: string; goal: string; status: string; deliverable: string | null; updated: string }>
  return rows.map(r => {
    const file = asyncDeliverablePath(root, r.id)
    return {
      source: 'async-run' as const,
      id: r.id,
      title: r.goal,
      path: file,
      status: r.status,
      updated: r.updated,
      bytes: r.deliverable?.length,
    }
  })
}

/** 无账本旧 root 的兼容视图:直接扫 async 目录的 deliverable 文件(只读,与清扫合同同一目录)。 */
async function listDeliverableFiles(root: string): Promise<ArtifactEntry[]> {
  const dir = join(root, 'gotry-state', 'async')
  let names: string[] = []
  try {
    names = (await readdir(dir)).filter(n => n.endsWith('.deliverable.md'))
  } catch {
    return []
  }
  const entries: ArtifactEntry[] = []
  for (const n of names) {
    const p = join(dir, n)
    const st = await stat(p).catch(() => null)
    if (!st?.isFile()) continue
    const canonical = await realpath(p).catch(() => null)
    if (!canonical || !underRoot(canonical, root) || hasDeniedSegment(canonical)) continue
    entries.push({
      source: 'async-run',
      id: n.replace(/\.deliverable\.md$/, ''),
      title: n.replace(/\.deliverable\.md$/, ''),
      path: p,
      status: existsSync(p.replace(/\.deliverable\.md$/, '.json')) ? 'pending-view' : 'legacy',
      updated: new Date(st.mtimeMs).toISOString(),
      bytes: st.size,
    })
  }
  return entries
}

/**
 * dsh 工作目录顶层可发现产物:md(agent 写出的行程规划等)+ html/htm 行程产物,
 * 扩展名大小写不敏感;非递归,排除 dotfiles。每源在 dedupe/全局排序之前不限
 * 数量——pageSize 由 listArtifacts 在排序后切片,避免 cwd 顶层 mtime 较老的
 * 产物被提前丢失。
 */
async function listCwdArtifacts(cwd: string): Promise<ArtifactEntry[]> {
  let dirents
  try {
    dirents = await readdir(cwd, { withFileTypes: true })
  } catch {
    return []
  }
  const entries: ArtifactEntry[] = []
  for (const d of dirents) {
    if (!d.isFile() || !CWD_DISCOVER_EXT.test(d.name) || d.name.startsWith('.')) continue
    const p = join(cwd, d.name)
    const st = await stat(p).catch(() => null)
    if (!st) continue
    const canonical = await realpath(p).catch(() => null)
    if (!canonical || !underRoot(canonical, cwd) || hasDeniedSegment(canonical)) continue
    entries.push({
      source: 'cwd-file',
      id: d.name,
      title: d.name.replace(CWD_DISCOVER_EXT, ''),
      path: p,
      updated: new Date(st.mtimeMs).toISOString(),
      bytes: st.size,
    })
  }
  return entries
}

export async function listArtifacts(opts: ListArtifactsOptions): Promise<ListArtifactsResult> {
  const limit = clampLimit(opts.limit)
  const offset = normalizeOffset(opts.offset, 'offset')
  const needle = normalizeSearch(opts.search) ?? ''
  const root = rootOf(opts.stateRoot)
  const cwd = opts.cwd ? resolve(opts.cwd) : process.cwd()
  const canonicalRoot = await realpath(root).catch(() => root)
  const canonicalCwd = await realpath(cwd).catch(() => cwd)

  // 1) collect all eligible entries per source, without per-source limits —
  //    pageSize is applied to the merged/deduped/sorted set so older cwd files
  //    stay reachable across pages.
  const collected: ArtifactEntry[] = [
    ...listRunsFromLedger(canonicalRoot, 'local'),
    ...(await listDeliverableFiles(canonicalRoot)),
    ...(await listCwdArtifacts(canonicalCwd)),
  ]

  // 2) canonical-path dedupe (keep ledger authority when both sources point
  //    at the same file).
  const seenPath = new Set<string>()
  const deduped: ArtifactEntry[] = []
  for (const e of collected) {
    if (seenPath.has(e.path)) continue
    seenPath.add(e.path)
    deduped.push(e)
  }

  // 3) literal, case-insensitive substring filter over id/title/filename.
  const filtered = needle === '' ? deduped : deduped.filter(e => matchesSearch(e, needle))

  // 4) deterministic global sort (updated DESC + lexical tie-break) so equal
  //    mtimes have a stable page boundary.
  filtered.sort(compareArtifacts)

  // 5) page slice. offset may exceed total — return an empty page with the
  //    known total and `truncated:false`.
  const total = filtered.length
  const start = Math.min(offset, total)
  const end = Math.min(start + limit, total)
  const page = filtered.slice(start, end)
  const hasMore = start + page.length < total

  const result: ListArtifactsResult = {
    artifacts: page,
    total,
    truncated: hasMore,
    limit,
    /** Echo the requested offset (post-validation) — not the clamped page start — so the caller can detect a beyond-end request. */
    offset,
    roots: [canonicalRoot, canonicalCwd],
  }
  if (hasMore) result.nextOffset = start + page.length
  if (needle !== '') result.search = needle
  return result
}

/**
 * 读一个产物。path 三形态:
 *   1. 裸工单 id(无 / 无 .)→ 账本 workflow_runs.deliverable(权威),文件视图缺失也能读;
 *   2. list 返回的绝对/相对路径 → 限定在 stateRoot 根或 dsh 工作目录内(排除 node_modules/.git);
 *   3. 相对文件名 → 先按 dsh 工作目录顶层,再按 gotry-state/async/ 找。
 * 窗口:offset(1 起)/limit(≤400 行);超窗返回 windowed:true,UI 用 read 卡渲染行号视图。
 */
export async function readArtifact(opts: {
  stateRoot: string
  cwd?: string
  path: string
  offset?: number
  limit?: number
}): Promise<ArtifactReadView | { ok: false; error: string; hint?: string }> {
  const root = rootOf(opts.stateRoot)
  const cwd = opts.cwd ? resolve(opts.cwd) : process.cwd()
  const canonicalRoot = await realpath(root).catch(() => root)
  const canonicalCwd = await realpath(cwd).catch(() => cwd)
  const raw = String(opts.path ?? '').trim()
  if (!raw) return { ok: false, error: 'path 必填(来自 gotry_artifacts_list 的 path,或异步工单 id)' }

  let text: string | null = null
  let filePath = ''

  // 1) 裸工单 id:账本权威读(文件视图缺失不挡阅读)
  if (!raw.includes('/') && !raw.includes('\\') && !raw.includes('.')) {
    const ledger = openLedgerIfExists(root, 'local')
    const run = ledger?.db
      .prepare('SELECT id, goal, status, deliverable FROM workflow_runs WHERE id = ? AND tenant_id = ?')
      .get(raw, ledger!.tenant) as { deliverable: string | null } | undefined
    if (run?.deliverable) {
      text = run.deliverable
      filePath = asyncDeliverablePath(root, raw)
    } else {
      const p = asyncDeliverablePath(root, raw)
      const canonical = await realpath(p).catch(() => null)
      if (canonical) {
        if (!underRoot(canonical, canonicalRoot) || hasDeniedSegment(canonical)) {
          return { ok: false, error: `路径越界:${raw}`, hint: `只读 ${root} 与 dsh 工作目录内的文本产物` }
        }
        const ext = canonical.slice(canonical.lastIndexOf('.') + 1).toLowerCase()
        if (!TEXT_EXT_LANG[ext]) {
          return { ok: false, error: `不支持的文件类型 .${ext}`, hint: `白名单:${Object.keys(TEXT_EXT_LANG).join('/')}` }
        }
        const st = await stat(canonical).catch(() => null)
        if (!st?.isFile()) return { ok: false, error: `文件不存在:${raw}`, hint: '先 gotry_artifacts_list 看在册产物' }
        if (st.size > MAX_BYTES) return { ok: false, error: `文件过大(${st.size} bytes > ${MAX_BYTES})` }
        filePath = canonical
        text = await readFile(canonical, 'utf-8')
      }
    }
    if (text === null) return { ok: false, error: `工单 ${raw} 无 deliverable(未交付或不存在)`, hint: '先 gotry_artifacts_list 看在册产物' }
  }

  // 2) 路径形态:目录白名单 + 扩展名白名单
  if (text === null) {
    const candidates = isAbsolute(raw) ? [resolve(raw)] : [resolve(cwd, raw), resolve(root, raw), resolve(root, 'gotry-state', 'async', raw)]
    // 预检按 cwd/root 的非 canonical 与 canonical 两种形态放行:list 返回的是 canonical
    // 路径(realpath 后的 cwd),而 macOS 上 /var 与 /private/var 这类符号链接会让
    // canonical 路径不匹配字面 cwd,导致 list→read 串联断裂。边界权威仍是下方
    // realpath 后的 canonical 复检,这里放宽不改变可读集合。
    const inScope = (p: string) => (underRoot(p, cwd) || underRoot(p, root) || underRoot(p, canonicalCwd) || underRoot(p, canonicalRoot)) && !hasDeniedSegment(p)
    // Prefer an existing candidate so a cwd miss does not mask a valid state-root file.
    const allowed = candidates.find(p => inScope(p) && existsSync(p)) ?? candidates.find(inScope)
    if (!allowed) {
      return { ok: false, error: `路径越界:${raw}`, hint: `只读 ${root} 与 dsh 工作目录内的文本产物` }
    }
    const canonical = await realpath(allowed).catch(() => null)
    if (!canonical) {
      return { ok: false, error: `文件不存在:${raw}`, hint: '先 gotry_artifacts_list 看在册产物' }
    }
    if (!(underRoot(canonical, canonicalCwd) || underRoot(canonical, canonicalRoot)) || hasDeniedSegment(canonical)) {
      return { ok: false, error: `路径越界:${raw}`, hint: `只读 ${root} 与 dsh 工作目录内的文本产物` }
    }
    const ext = canonical.slice(canonical.lastIndexOf('.') + 1).toLowerCase()
    if (!TEXT_EXT_LANG[ext]) {
      return { ok: false, error: `不支持的文件类型 .${ext}`, hint: `白名单:${Object.keys(TEXT_EXT_LANG).join('/')}` }
    }
    const st = await stat(canonical).catch(() => null)
    if (!st?.isFile()) return { ok: false, error: `文件不存在:${raw}`, hint: '先 gotry_artifacts_list 看在册产物' }
    if (st.size > MAX_BYTES) return { ok: false, error: `文件过大(${st.size} bytes > ${MAX_BYTES})` }
    filePath = canonical
    text = await readFile(canonical, 'utf-8')
  }

  const allLines = text.split('\n')
  const offset = Math.max(1, Math.min(opts.offset ?? 1, allLines.length))
  const limit = Math.max(1, Math.min(opts.limit ?? MAX_WINDOW, MAX_WINDOW))
  const slice = allLines.slice(offset - 1, offset - 1 + limit)
  const ext = filePath.slice(filePath.lastIndexOf('.') + 1).toLowerCase()
  return {
    ok: true,
    source: underRoot(filePath, canonicalRoot) ? 'state-root' : 'cwd',
    path: filePath,
    offset,
    lines: slice.map((t, i) => ({ number: offset + i, text: t })),
    totalLines: allLines.length,
    lang: TEXT_EXT_LANG[ext] ?? 'text',
    version: createHash('sha256').update(text).digest('hex').slice(0, 12),
    content: slice.join('\n'),
    windowed: allLines.length > offset - 1 + slice.length,
  }
}
