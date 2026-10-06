#!/usr/bin/env node
/**
 * scripts/post-release-docs.mjs — record a verified release in the docs, and only a verified one.
 *
 * AGENTS.md: no authority may say "published" before the registry pull-back passed. This script is the only
 * thing that writes that claim, and it refuses without a receipt that verify-published.mjs wrote after a full
 * pass (registry facts, tarball bytes and the clean-room run). It edits the pairs together or not at all,
 * because a half-updated en/zh pair is a bug (docs i18n discipline):
 *
 *   README.md / README.zh-CN.md          the "on npm (`latest`)" status line and the version baseline
 *   docs/user-guide{,.zh-CN}.md          the pinned-version example
 *   docs/roadmap{,.zh-CN}.md             the "Published package" row (the rc tag's target too)
 *   docs/release-notes{,.zh-CN}.md       a "Published" section in the version's block, facts from the receipt
 *
 * The baseline files describe the `latest` dist-tag, so only a release published to `latest` touches them;
 * any other dist-tag only gets its release-notes section. Idempotent: a second run changes nothing.
 *
 * Usage:
 *   node scripts/post-release-docs.mjs [--receipt <path>] [--root <dir>] [--date YYYY-MM-DD] [--check]
 * --check writes nothing and exits 1 when the docs are not yet up to date with the receipt.
 * Exit: 0 done / up to date; 1 a doc shape was not recognised (nothing written) or --check found work; 2 usage.
 */
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { UsageError, VERIFIED_FILE, compareSemver, isMain } from './release-lib.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const REPO_URL = 'https://github.com/Danceiny/gotry'
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

export function parseArgs(argv) {
  const opts = { receipt: '', root: ROOT, date: '', check: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const value = () => {
      const v = argv[++i]
      if (v === undefined || v.startsWith('--')) throw new UsageError(`${a} needs a value`)
      return v
    }
    if (a === '--receipt') opts.receipt = value()
    else if (a === '--root') opts.root = resolve(value())
    else if (a === '--date') opts.date = value()
    else if (a === '--check') opts.check = true
    else if (a === '-h' || a === '--help') throw new UsageError('')
    else throw new UsageError(`unknown argument ${a}`)
  }
  if (opts.date && !/^\d{4}-\d{2}-\d{2}$/.test(opts.date)) throw new UsageError('--date must be YYYY-MM-DD')
  return opts
}

/** The receipt must be a full, passing pull-back; anything weaker never reaches the docs. */
export function assertReceipt(receipt) {
  if (receipt?.schema !== 'gotry_release_verified_v1') throw new Error('not a verify-published.mjs receipt (schema gotry_release_verified_v1)')
  if (receipt.ok !== true) throw new Error('the receipt records a failed pull-back')
  if (receipt.cleanRoom !== true) throw new Error('the receipt is registry-only: the clean-room run did not happen, so this is not the pull-back')
  if (!receipt.version || !receipt.tag || !receipt.registry?.shasum) throw new Error('the receipt lacks version, tag or registry facts')
}

function publishedText(lang, r, date) {
  const matched = r.checks.some((c) => c.name === 'registry: matches the pre-publish build' && c.ok)
  const rc = r.registry.distTags?.rc
  const files = r.registry.fileCount != null ? (lang === 'en' ? `, ${r.registry.fileCount} files` : `，${r.registry.fileCount} 个文件`) : ''
  const link = `[v${r.version}](${REPO_URL}/releases/tag/v${r.version})`
  if (lang === 'en') {
    const predicted = matched ? ' — the shasum `npm pack --dry-run` predicted from the tagged tree before publishing —' : ''
    const rcSentence = rc && rc !== r.version ? ` The compatibility \`rc\` tag is still on \`${rc}\`.` : ''
    return `Published to npm on ${date} as \`${r.name}@${r.version}\` with \`TAG=${r.tag} ./scripts/publish-npm.sh\` (tag passed explicitly, #50①), then pulled back from the registry: \`npm view\` shows \`${r.tag}\` → \`${r.version}\` (shasum \`${r.registry.shasum}\`${files})${predicted} and the downloaded tarball hashes to it. On a clean machine (fresh HOME and npm cache, official registry only, no LLM key) \`npx ${r.name}@${r.version}\` passes end to end: \`doctor\` prints its report, the dist entry loads the \`gotry-tools\` plugin, \`web\` boots (token URL 303 → 200, no token 401), and a one-shot without credentials fails with the host's missing-credential message rather than a stack trace. GitHub Release: ${link}.${rcSentence}`
  }
  const predicted = matched ? '，与发布前由已打 tag 的源码树经 `npm pack --dry-run` 预测的 shasum 一致' : ''
  const rcSentence = rc && rc !== r.version ? `兼容用 \`rc\` tag 仍指向 \`${rc}\`。` : ''
  return `${date} 以 \`TAG=${r.tag} ./scripts/publish-npm.sh\`（dist-tag 显式传入，#50①）发布 \`${r.name}@${r.version}\`，并从 registry 回拉校验：\`npm view\` 显示 \`${r.tag}\` → \`${r.version}\`（shasum \`${r.registry.shasum}\`${files}）${predicted}，下载的 tarball 字节哈希同样吻合。在干净机器上（全新 HOME 与 npm 缓存、仅官方 registry、无 LLM key）\`npx ${r.name}@${r.version}\` 端到端通过：\`doctor\` 打印报告，dist 入口能加载 \`gotry-tools\` 插件，\`web\` 可启动（带 token 的 URL 303 → 200，无 token 为 401），无凭证的一次性任务以宿主的缺凭证提示失败，而不是抛出堆栈。GitHub Release：${link}。${rcSentence}`
}

/** Insert "### Published" before the `---` that closes the version's block, unless the block already has one. */
function addPublishedSection(text, version, heading, body) {
  const lines = text.split('\n')
  const start = lines.findIndex((l) => new RegExp(`^## v${escapeRe(version)}(?=\\s|$)`).test(l))
  if (start === -1) return { error: `no "## v${version}" block` }
  let end = lines.findIndex((l, i) => i > start && (l === '---' || /^## /.test(l)))
  if (end === -1) end = lines.length
  if (lines.slice(start, end).some((l) => l === `### ${heading}`)) return { text, changed: false }
  let at = end
  while (at > start + 1 && lines[at - 1].trim() === '') at--
  lines.splice(at, 0, '', `### ${heading}`, '', body)
  return { text: lines.join('\n'), changed: true }
}

/**
 * One substitution that must match: the middle group of `pattern` (the old value) becomes `value`. A function
 * replacer on purpose — a "$1" + "0.2.0…" string would read as the group reference "$10".
 */
function substitute(text, pattern, value) {
  const m = pattern.exec(text)
  if (!m) return { error: `pattern ${pattern} not found` }
  const next = text.replace(pattern, (_all, pre, _old, post) => `${pre}${value}${post}`)
  return { text: next, changed: next !== text, previous: m[2] }
}

/**
 * Pure planner: files = { relativePath: content }, returns { files, report } or { errors }.
 * Nothing is written by this function; the caller writes all or none.
 */
export function planEdits(files, receipt, date) {
  assertReceipt(receipt)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`no usable publish date (${JSON.stringify(date)}): the receipt has no verifiedAt and --date was not given`)
  const out = { ...files }
  const report = []
  const errors = []
  const v = receipt.version
  const apply = (path, steps) => {
    if (files[path] === undefined) { errors.push(`${path}: file missing`); return }
    let text = out[path]
    let changed = false
    for (const step of steps) {
      const r = step(text)
      if (r.error) { errors.push(`${path}: ${r.error}`); return }
      text = r.text
      changed ||= r.changed
    }
    out[path] = text
    report.push({ path, changed })
  }
  // `tracks` marks a place that names the published version: it must never move backwards (a stale receipt, or a
  // docs branch that is already ahead, is a mistake to surface rather than to overwrite).
  const sub = (pattern, value, tracks = false) => (text) => {
    const r = substitute(text, pattern, value)
    if (!r.error && tracks && compareSemver(v, r.previous) === -1) return { error: `already says ${r.previous}, newer than the receipt's ${v}` }
    return r
  }

  if (receipt.tag === 'latest') {
    const name = escapeRe(receipt.name)
    apply('README.md', [
      sub(/(\*\*v)([0-9][^*\s]*)(\*\* on npm \(`latest`\))/, v, true),
      sub(/(Version baseline: `v)([^`]+)(` \(npm `latest`\))/, v),
    ])
    apply('README.zh-CN.md', [
      sub(/(npm `latest`：\*\*v)([0-9][^*\s]*)(\*\*)/, v, true),
      sub(/(版本基线：`v)([^`]+)(`（npm `latest`）)/, v),
    ])
    for (const path of ['docs/user-guide.md', 'docs/user-guide.zh-CN.md']) {
      apply(path, [sub(new RegExp(`(\`npx ${name}@)([0-9][^\\s\`]*)( web\`)`), v, true)])
    }
    const rc = receipt.registry.distTags?.rc
    const roadmap = (row, rcPattern) => [sub(row, v, true), ...(rc ? [sub(rcPattern, rc)] : [])]
    apply('docs/roadmap.md', roadmap(
      /(\| Published package \| npm `latest` points to `)([^`]+)(`)/,
      /(compatibility `rc` tag remains on `)([^`]+)(`)/,
    ))
    apply('docs/roadmap.zh-CN.md', roadmap(
      /(\| 已发布包 \| npm `latest` 指向 `)([^`]+)(`)/,
      /(兼容用 `rc` tag 仍指向 `)([^`]+)(`)/,
    ))
  }
  apply('docs/release-notes.md', [(t) => addPublishedSection(t, v, 'Published', publishedText('en', receipt, date))])
  apply('docs/release-notes.zh-CN.md', [(t) => addPublishedSection(t, v, '已发布', publishedText('zh', receipt, date))])
  return errors.length ? { errors } : { files: out, report }
}

const FILES = [
  'README.md', 'README.zh-CN.md', 'docs/user-guide.md', 'docs/user-guide.zh-CN.md',
  'docs/roadmap.md', 'docs/roadmap.zh-CN.md', 'docs/release-notes.md', 'docs/release-notes.zh-CN.md',
]

async function main() {
  let opts
  try { opts = parseArgs(process.argv.slice(2)) } catch (err) {
    if (err instanceof UsageError) {
      console.error(`${err.message ? `error: ${err.message}\n` : ''}usage: node scripts/post-release-docs.mjs [--receipt <path>] [--root <dir>] [--date YYYY-MM-DD] [--check]`)
      return 2
    }
    throw err
  }
  const receiptPath = resolve(opts.receipt || join(ROOT, VERIFIED_FILE))
  if (!existsSync(receiptPath)) {
    console.error(`error: no receipt at ${receiptPath} — run scripts/verify-published.mjs first; docs never claim "published" without it`)
    return 2
  }
  let receipt
  try { receipt = JSON.parse(readFileSync(receiptPath, 'utf8')) } catch (err) {
    console.error(`error: cannot read the receipt ${receiptPath}: ${err.message}`)
    return 2
  }
  const files = {}
  for (const f of FILES) if (existsSync(join(opts.root, f)) && statSync(join(opts.root, f)).isFile()) files[f] = readFileSync(join(opts.root, f), 'utf8')
  let plan
  try { plan = planEdits(files, receipt, opts.date || String(receipt.verifiedAt ?? '').slice(0, 10)) } catch (err) {
    console.error(`error: ${err.message}`)
    return 2
  }
  if (plan.errors) {
    console.error(`docs not recognised — nothing was written:\n${plan.errors.map((e) => `  ${e}`).join('\n')}\nEdit by hand, or teach scripts/post-release-docs.mjs the new shape.`)
    return 1
  }
  const todo = plan.report.filter((r) => r.changed)
  for (const r of plan.report) console.log(`${r.changed ? (opts.check ? '✏️  would update' : '✅ updated') : '➖ unchanged'} ${r.path}`)
  if (opts.check) {
    console.log(todo.length ? `\nDOCS ARE BEHIND ${receipt.name}@${receipt.version}: ${todo.length} file(s) need updating` : `\nDOCS ARE UP TO DATE with ${receipt.name}@${receipt.version}`)
    return todo.length ? 1 : 0
  }
  for (const r of todo) writeFileSync(join(opts.root, r.path), plan.files[r.path])
  console.log(todo.length ? `\nrecorded ${receipt.name}@${receipt.version} in ${todo.length} file(s); now run check-docs-i18n and check-doc-readability, then open the docs PR` : `\nnothing to do: the docs already record ${receipt.name}@${receipt.version}`)
  return 0
}

if (isMain(import.meta.url)) {
  main().then((code) => process.exit(code), (err) => { console.error(err); process.exit(2) })
}
