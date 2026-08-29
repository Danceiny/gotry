/**
 * 产物面(issue #25):agent 生成的文件不再只是「落在本地文件系统里的一个文件名」。
 *
 * 只读能力层,两个纯函数入口(dsh 工具 gotry_artifacts_list / gotry_artifacts_read 的实现):
 *   - listArtifacts: 产物发现。权威源 = 账本 workflow_runs(ADR-15;无账本的旧 root 回退
 *     扫描 gotry-state/async/*.deliverable.md 文件视图),外加 dsh 工作目录顶层 *.md
 *     (agent 写出的行程/规划文件正落在这里——issue 截图里的 trip-2027-*.md 即此类)。
 *   - readArtifact: 产物阅读。行窗口(offset/limit)+ 原始行号,输出 dsh read 卡所需的
 *     全部字段({number,text}[] / totalLines / lang),UI 侧渲染为行号文件视图。
 *
 * 纪律:本层只读(不写任何文件;WriteGate 红线不涉及);读取范围白名单 =
 * stateRoot 根 + dsh 工作目录(排除 node_modules/.git),扩展名白名单 =
 * 文本类(md/txt/json/jsonl/csv/log/yaml/yml)——本工具是「产物查看」,不是通用文件浏览器。
 */

import { readdir, readFile, stat } from 'node:fs/promises'
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
  path: string
  offset: number
  lines: Array<{ number: number; text: string }>
  totalLines: number
  lang?: string
  content: string
  windowed: boolean
}

const MAX_LIST = 50
const MAX_WINDOW = 400
const MAX_BYTES = 2 * 1024 * 1024
const TEXT_EXT_LANG: Record<string, string> = {
  md: 'markdown', txt: 'text', json: 'json', jsonl: 'json', csv: 'csv', log: 'text', yaml: 'yaml', yml: 'yaml',
}
const DIR_DENY = ['node_modules', '.git']

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

/** 账本 workflow_runs 是权威(listWorkflowRuns 只读 SELECT 直查,不为一个视图改 ledger 类)。 */
function listRunsFromLedger(root: string, tenant: string, limit: number): ArtifactEntry[] {
  const ledger = openLedgerIfExists(root, tenant)
  if (!ledger) return []
  const rows = ledger.db
    .prepare('SELECT id, goal, status, deliverable, updated FROM workflow_runs WHERE tenant_id = ? ORDER BY updated DESC LIMIT ?')
    .all(ledger.tenant, limit) as Array<{ id: string; goal: string; status: string; deliverable: string | null; updated: string }>
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
async function listDeliverableFiles(root: string, limit: number): Promise<ArtifactEntry[]> {
  const dir = join(root, 'gotry-state', 'async')
  let names: string[] = []
  try {
    names = (await readdir(dir)).filter(n => n.endsWith('.deliverable.md'))
  } catch {
    return []
  }
  const entries: ArtifactEntry[] = []
  for (const n of names.slice(0, limit * 2)) {
    const p = join(dir, n)
    const st = await stat(p).catch(() => null)
    if (!st?.isFile()) continue
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
  return entries.sort((a, b) => String(b.updated).localeCompare(String(a.updated)))
}

/** dsh 工作目录顶层 *.md(agent 写出的行程规划等);非递归,排除 dotfiles。 */
async function listCwdMarkdown(cwd: string, limit: number): Promise<ArtifactEntry[]> {
  let dirents
  try {
    dirents = await readdir(cwd, { withFileTypes: true })
  } catch {
    return []
  }
  const entries: ArtifactEntry[] = []
  for (const d of dirents) {
    if (!d.isFile() || !/\.md$/i.test(d.name) || d.name.startsWith('.')) continue
    const p = join(cwd, d.name)
    const st = await stat(p).catch(() => null)
    if (!st) continue
    entries.push({
      source: 'cwd-file',
      id: d.name,
      title: d.name.replace(/\.md$/i, ''),
      path: p,
      updated: new Date(st.mtimeMs).toISOString(),
      bytes: st.size,
    })
  }
  return entries.sort((a, b) => String(b.updated).localeCompare(String(a.updated))).slice(0, limit)
}

export async function listArtifacts(opts: {
  stateRoot: string
  cwd?: string
  limit?: number
}): Promise<{ artifacts: ArtifactEntry[]; total: number; truncated: boolean; roots: string[] }> {
  const limit = Math.max(1, Math.min(opts.limit ?? 20, MAX_LIST))
  const root = rootOf(opts.stateRoot)
  const cwd = opts.cwd ? resolve(opts.cwd) : process.cwd()

  const seenPath = new Set<string>()
  const merged: ArtifactEntry[] = []
  for (const e of [...listRunsFromLedger(root, 'local', limit), ...(await listDeliverableFiles(root, limit)), ...(await listCwdMarkdown(cwd, limit))]) {
    if (seenPath.has(e.path)) continue
    seenPath.add(e.path)
    merged.push(e)
  }
  merged.sort((a, b) => String(b.updated ?? '').localeCompare(String(a.updated ?? '')))

  const total = merged.length
  return { artifacts: merged.slice(0, limit), total, truncated: total > limit, roots: [root, cwd] }
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
      if (existsSync(p)) { filePath = p; text = await readFile(p, 'utf-8') }
    }
    if (text === null) return { ok: false, error: `工单 ${raw} 无 deliverable(未交付或不存在)`, hint: '先 gotry_artifacts_list 看在册产物' }
  }

  // 2) 路径形态:目录白名单 + 扩展名白名单
  if (text === null) {
    const candidates = isAbsolute(raw) ? [resolve(raw)] : [resolve(cwd, raw), resolve(root, raw), resolve(root, 'gotry-state', 'async', raw)]
    const allowed = candidates.find(p => (underRoot(p, cwd) || underRoot(p, root)) && !hasDeniedSegment(p))
    if (!allowed) {
      return { ok: false, error: `路径越界:${raw}`, hint: `只读 ${root} 与 dsh 工作目录内的文本产物` }
    }
    const ext = allowed.slice(allowed.lastIndexOf('.') + 1).toLowerCase()
    if (!TEXT_EXT_LANG[ext]) {
      return { ok: false, error: `不支持的文件类型 .${ext}`, hint: `白名单:${Object.keys(TEXT_EXT_LANG).join('/')}` }
    }
    const st = await stat(allowed).catch(() => null)
    if (!st?.isFile()) return { ok: false, error: `文件不存在:${raw}`, hint: '先 gotry_artifacts_list 看在册产物' }
    if (st.size > MAX_BYTES) return { ok: false, error: `文件过大(${st.size} bytes > ${MAX_BYTES})` }
    filePath = allowed
    text = await readFile(allowed, 'utf-8')
  }

  const allLines = text.split('\n')
  const offset = Math.max(1, Math.min(opts.offset ?? 1, allLines.length))
  const limit = Math.max(1, Math.min(opts.limit ?? MAX_WINDOW, MAX_WINDOW))
  const slice = allLines.slice(offset - 1, offset - 1 + limit)
  const ext = filePath.slice(filePath.lastIndexOf('.') + 1).toLowerCase()
  return {
    ok: true,
    path: filePath,
    offset,
    lines: slice.map((t, i) => ({ number: offset + i, text: t })),
    totalLines: allLines.length,
    lang: TEXT_EXT_LANG[ext] ?? 'text',
    content: slice.join('\n'),
    windowed: allLines.length > offset - 1 + slice.length,
  }
}
