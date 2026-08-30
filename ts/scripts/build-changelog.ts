/**
 * CHANGELOG.md 自动生成器(Keep a Changelog 1.1.0 + Conventional Commits 解析)
 *
 * 设计(2026-08-30 owner 拍板:AGENTS.md 「发布闸」+ 「doc-only 同步纪律」延伸):
 *   - 输入:`git log <prev-tag>..HEAD --no-merges`,从 package.json 锁定当前版本号;
 *   - 解析 Conventional Commits:feat/fix/perf/refactor/docs/test/build/ci/chore/revert
 *     + 可选 scope(`feat(scope):`)——scope 用于同一节内归类;
 *   - 输出:Keep a Changelog 1.1.0 节结构(Added/Changed/Fixed/Removed/Security),
 *     在 `CHANGELOG.md` 顶部插入新版本段;**已有 CHANGELOG.md 的历史段原样保留**(不重写)。
 *   - PR 引用 `#NN` 写入条目尾(支持自动跨 commit 链接)。
 *
 * 运行(在 ts/ 下):
 *   npx tsx scripts/build-changelog.ts                  # 从上一 tag 到 HEAD 生成段,stdout 打印 diff 提示
 *   npx tsx scripts/build-changelog.ts --write           # 写入 CHANGELOG.md(覆盖顶部新版本段)
 *   npx tsx scripts/build-changelog.ts --since v0.0.1-rc.15
 *   npx tsx scripts/build-changelog.ts --version 0.0.1-rc.16 --date 2026-08-30
 *
 * 不接 Conventional Commits 严格门:commit subject 不一定全符合(历史 commit 多为长中文),
 * parser 容错——只把带 type: 前缀的归类,其余落入「Other(未分类)」,保持版本段完整可读。
 */

import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

export type ConventionalType = 'feat' | 'fix' | 'perf' | 'refactor' | 'docs' | 'test' | 'build' | 'ci' | 'chore' | 'revert'

export interface ParsedCommit {
  sha: string
  type: ConventionalType | 'other'
  scope: string | null
  subject: string
  /** PR 引用,如 #68 */
  prRef: string | null
  raw: string
}

export interface ChangelogSection {
  type: ConventionalType | 'other'
  items: Array<{ subject: string; sha: string; prRef: string | null }>
}

export interface ChangelogEntry {
  version: string
  date: string
  /** 解析后的所有 sections,按 Keep a Changelog 显示顺序 */
  sections: ChangelogSection[]
}

const TYPE_TO_KEEP_A_CHANGELOG: Record<ConventionalType, string> = {
  feat: 'Added',
  fix: 'Fixed',
  perf: 'Changed',
  refactor: 'Changed',
  docs: 'Documentation',
  test: 'Tests',
  build: 'Build',
  ci: 'CI',
  chore: 'Chore',
  revert: 'Reverted',
}

const DISPLAY_ORDER: Array<ConventionalType | 'other'> = [
  'feat', 'fix', 'perf', 'refactor', 'revert', 'docs', 'test', 'build', 'ci', 'chore', 'other',
]

const CONVENTIONAL_RE = /^(feat|fix|perf|refactor|docs|test|build|ci|chore|revert)(?:\(([^)]+)\))?(!)?:\s*(.+)$/

export function parseCommit(raw: string): ParsedCommit | null {
  const lines = raw.split('\n')
  const firstLine = lines[0] ?? ''
  if (!firstLine) return null
  // Conventional Commits 形如: "feat(scope)!: subject (#PR)" — 把尾 (#NN) 单独拆出来,
  // 防 subject 内的 (xxx) 被 CONVENTIONAL_RE 的 scope-group (\\([^)]+\\)) 误吞。
  const { head, prRef } = splitSubjectAndPr(firstLine)
  const match = head.match(CONVENTIONAL_RE)
  if (!match) {
    return {
      sha: '',
      type: 'other',
      scope: null,
      subject: head,
      prRef,
      raw,
    }
  }
  const [, type, scope] = match
  // subject:从 ": " 之后到行尾(已被 splitSubjectAndPr 切过尾)
  const colonIdx = head.indexOf(': ')
  const subject = colonIdx >= 0 ? head.slice(colonIdx + 2).trim() : head
  return {
    sha: '',
    type: type as ConventionalType,
    scope: scope ?? null,
    subject,
    prRef,
    raw,
  }
}

function splitSubjectAndPr(text: string): { head: string; prRef: string | null } {
  // 行尾的 " (#NN)" 拆出来;中文长 subject 中也可能有"(...)"形态,只切最后那个
  const m = text.match(/\s+\(#(\d+)\)\s*$/)
  if (m) return { head: text.slice(0, m.index).trim(), prRef: m[1] }
  return { head: text.trim(), prRef: null }
}

function extractPrRef(text: string): string | null {
  const m = text.match(/\(#(\d+)\)/)
  return m ? m[1] : null
}

/** 用 git log 取 commit 列表(纯 NUL 分隔,避免 subject 内的换行/中文干扰)
 *  格式(每 commit):hash<NUL>subject<NUL>body<NUL>SEPARATOR<NUL>
 *  返回:hash 与 subject 在不同字段的 ParsedCommit-friendly 数组(不预先 merge) */
export interface RawCommit {
  sha: string
  subject: string
  body: string
}

export function listCommits(opts: { cwd: string; since?: string; until?: string }): RawCommit[] {
  const args = ['log', '--no-merges', '--pretty=format:%H%x00%s%x00%b%x00%x1e']
  if (opts.since) args.push(`${opts.since}..HEAD`)
  const out = execFileSync('git', args, { cwd: opts.cwd, encoding: 'utf8' })
  if (!out) return []
  return out.split('\u001e').filter(Boolean).map((raw) => {
    const [sha, subject, body] = raw.split('\u0000').map((s) => (s ?? '').trim())
    return { sha: sha ?? '', subject: subject ?? '', body: body ?? '' }
  })
}

/** 把 commit 列表分类成 sections;相同 type 合并,scope 作为 sub-group(同 type 内) */
export function groupCommits(commits: ParsedCommit[]): ChangelogSection[] {
  const sections = new Map<string, ChangelogSection>()
  for (const c of commits) {
    if (!sections.has(c.type)) sections.set(c.type, { type: c.type, items: [] })
    sections.get(c.type)!.items.push({ subject: c.subject, sha: c.sha, prRef: c.prRef })
  }
  // 按 DISPLAY_ORDER 输出
  const out: ChangelogSection[] = []
  for (const t of DISPLAY_ORDER) {
    const sec = sections.get(t)
    if (sec && sec.items.length > 0) out.push(sec)
  }
  return out
}

export function renderMarkdownEntry(entry: ChangelogEntry): string {
  const lines: string[] = []
  lines.push(`## [${entry.version}] - ${entry.date}`)
  lines.push('')
  for (const sec of entry.sections) {
    const header = sec.type === 'other' ? 'Other' : (TYPE_TO_KEEP_A_CHANGELOG[sec.type as ConventionalType] ?? sec.type)
    lines.push(`### ${header}`)
    lines.push('')
    for (const item of sec.items) {
      const subject = truncateSubject(item.subject, 120)
      const suffix = item.prRef ? ` (#${item.prRef})` : (item.sha ? ` (${item.sha.slice(0, 7)})` : '')
      lines.push(`- ${subject}${suffix}`)
    }
    lines.push('')
  }
  return lines.join('\n')
}

/** 长 subject 在第一个「。」/「——」/「;」处截断,防历史超长 commit message 把 CHANGELOG 撑爆;
 *  失败兜底:超过 2×max 字符直接切 + …(短 breaker 优先;超长用纯字符切片) */
function truncateSubject(text: string, max: number): string {
  if (text.length <= max * 2) {
    const breakers = ['。', '——', '; ', ' — ', ',', '，']
    for (const b of breakers) {
      const i = text.indexOf(b)
      if (i > 30 && i <= max * 2) return `${text.slice(0, i).trim()}…`
    }
  }
  return `${text.slice(0, max).trim()}…`
}

export function buildEntry(opts: { version: string; date: string; commits: ParsedCommit[] }): ChangelogEntry {
  return { version: opts.version, date: opts.date, sections: groupCommits(opts.commits) }
}

interface ChangelogFile {
  preamble: string
  history: string[]
}

const CHANGELOG_HEADER = `# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

`

export function splitChangelog(raw: string): ChangelogFile {
  // 找第一个 "## [" 位置——之前的全是 preamble
  const firstSection = raw.indexOf('\n## [')
  if (firstSection < 0) return { preamble: raw.endsWith('\n') ? raw : `${raw}\n`, history: [] }
  const preamble = raw.slice(0, firstSection + 1) // 含末尾换行
  const history = raw.slice(firstSection + 1)
  return { preamble, history: [history] }
}

export function prependEntry(raw: string, entryMarkdown: string): string {
  if (!existsSync(join('..', 'CHANGELOG.md')) && !raw) {
    return CHANGELOG_HEADER + entryMarkdown
  }
  const split = splitChangelog(raw || (CHANGELOG_HEADER + ''))
  // 头:preamble + 新版本段 + 历史段(history 中已含首个 "\n## [")
  return split.preamble + entryMarkdown + '\n' + split.history.join('').replace(/^\n/, '')
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] : undefined
}

function readPackageVersion(): string {
  const raw = JSON.parse(readFileSync(join('..', 'package.json'), 'utf8')) as { version?: string }
  if (!raw.version) throw new Error('package.json 缺 version 字段')
  return raw.version
}

function gitHeadSha(): string {
  return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
}

export interface BuildOptions {
  cwd: string
  version: string
  date: string
  since: string
}

export function buildFromGit(opts: BuildOptions): { entry: ChangelogEntry; markdown: string } {
  const rawCommits = listCommits({ cwd: opts.cwd, since: opts.since })
  const parsed: ParsedCommit[] = []
  for (const r of rawCommits) {
    const m = parseCommit(r.subject)
    if (!m) continue
    m.sha = r.sha
    m.raw = r.body
    parsed.push(m)
  }
  const entry = buildEntry({ version: opts.version, date: opts.date, commits: parsed })
  const markdown = renderMarkdownEntry(entry)
  return { entry, markdown }
}

async function main(): Promise<void> {
  const cwd = join('..')
  const version = arg('--version') ?? readPackageVersion()
  const date = arg('--date') ?? new Date().toISOString().slice(0, 10)
  const since = arg('--since')
  const write = process.argv.includes('--write')

  let sinceTag = since
  if (!sinceTag) {
    // 自动推断:取 tags 中 < version 的最高 tag
    const out = execFileSync('git', ['tag', '-l', 'v*', '--sort=-v:refname'], { cwd, encoding: 'utf8' })
    const tags = out.split('\n').map((t) => t.trim()).filter(Boolean)
    sinceTag = tags.find((t) => t !== `v${version}` && tagsAreLessThan(t, `v${version}`)) ?? tags[tags.length - 1]
  }
  if (!sinceTag) {
    console.error('build-changelog: 找不到起始 tag;传 --since <tag> 显式指定')
    process.exit(2)
  }

  const { entry, markdown } = buildFromGit({ cwd, version, date, since: sinceTag })
  const existing = existsSync(join(cwd, 'CHANGELOG.md')) ? readFileSync(join(cwd, 'CHANGELOG.md'), 'utf8') : ''
  const next = write ? prependEntry(existing, markdown) : markdown
  console.log(`# build-changelog: ${entry.sections.length} sections / ${entry.sections.reduce((n, s) => n + s.items.length, 0)} commits since ${sinceTag}`)
  for (const sec of entry.sections) {
    console.log(`## ${sec.type} (${sec.items.length})`)
    for (const it of sec.items) console.log(`  - ${it.subject}${it.prRef ? ` (#${it.prRef})` : ''}`)
  }
  if (write) {
    writeFileSync(join(cwd, 'CHANGELOG.md'), next, 'utf8')
    console.log(`\n>> wrote CHANGELOG.md (${next.length}B) @ ${gitHeadSha().slice(0, 7)}`)
  }
}

function tagsAreLessThan(a: string, b: string): boolean {
  // 简化:字符串字典序比较(对 v0.0.1-rc.N 系列足够;复杂语义版本需 semver 库)
  return a < b
}

if (process.argv[1]?.endsWith('build-changelog.ts')) {
  main().catch((e) => {
    console.error(`build-changelog error: ${(e as Error).message}`)
    process.exit(1)
  })
}