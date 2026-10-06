#!/usr/bin/env node
/**
 * Tests for scripts/post-release-docs.mjs.
 *
 * The planner is pure, so most checks feed it synthetic docs in the real shapes; the CLI is run as a subprocess in
 * temporary directories. One check reads this checkout's real docs: if a README/roadmap/user-guide rewrite stops
 * the script from recognising them, that fails here, in the regression gate, instead of on release day.
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertReceipt, parseArgs, planEdits } from './post-release-docs.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const SCRIPT = join(HERE, 'post-release-docs.mjs')
let checks = 0
const ok = (cond, msg) => { assert.ok(cond, msg); checks++ }
const eq = (a, b, msg) => { assert.deepEqual(a, b, msg); checks++ }
const throws = (fn, re, msg) => { assert.throws(fn, re, msg); checks++ }

const NAME = '@scope/pkg'
const OLD = '0.2.0-rc.20'
const NEW = '0.2.0-rc.21'
const SHA = 'ab12'.repeat(10)
const DATE = '2026-10-06'

const receipt = (over = {}) => ({
  schema: 'gotry_release_verified_v1',
  name: NAME,
  version: NEW,
  tag: 'latest',
  ok: true,
  registry: { shasum: SHA, integrity: 'sha512-xyz', fileCount: 12, unpackedSize: 4096, distTags: { latest: NEW, rc: '0.0.1-rc.20', 'rc.5': '0.0.1-rc.5' } },
  cleanRoom: true,
  node: 'v24.0.0',
  platform: 'linux-x64',
  checks: [
    { name: 'registry: version visible', ok: true },
    { name: 'registry: matches the pre-publish build', ok: true },
    { name: 'clean room: web', ok: true },
  ],
  verifiedAt: `${DATE}T08:00:00.000Z`,
  ...over,
})

/** The docs as they stand right after the version bump and before the publish. */
function docs({ baseline = OLD, rc = '0.0.1-rc.20', block = true, published = false, endOfFile = false } = {}) {
  const notes = (title, whatsNew, installation, publishedHeading, publishedText) => [
    `# ${title}`, '', '---', '', '## Unreleased', '', '---', '',
    ...(block ? [
      `## v${NEW} · 2026-10-06`, '', `### ${whatsNew}`, '', '- a change', '', `### ${installation}`, '', `Run \`npx ${NAME}@${NEW} web\`.`,
      ...(published ? ['', `### ${publishedHeading}`, '', publishedText] : []),
      ...(endOfFile ? [] : ['', '---', '']),
    ] : []),
    ...(endOfFile ? [] : [`## v${OLD} · 2026-10-01`, '', `### ${whatsNew}`, '', '- an older change', '', `### ${publishedHeading}`, '', 'older published text', '', '---', '']),
  ].join('\n')
  return {
    'README.md': `# Demo\n\n**v${baseline}** on npm (\`latest\`). Pre-1.0.\n\nMore text.\n\n**Version baseline: \`v${baseline}\` (npm \`latest\`).** Gates.\n`,
    'README.zh-CN.md': `# 演示\n\nnpm \`latest\`：**v${baseline}**。未到 1.0。\n\n更多文字。\n\n**版本基线：\`v${baseline}\`（npm \`latest\`）。** 验证闸。\n`,
    'docs/user-guide.md': `# Guide\n\n> Pin an exact version (e.g. \`npx ${NAME}@${baseline} web\`).\n`,
    'docs/user-guide.zh-CN.md': `# 指南\n\n> 钉精确版本（如 \`npx ${NAME}@${baseline} web\`）。\n`,
    'docs/roadmap.md': `# Roadmap\n\n| Published package | npm \`latest\` points to \`${baseline}\`; the compatibility \`rc\` tag remains on \`${rc}\`. Source may be ahead. | x |\n`,
    'docs/roadmap.zh-CN.md': `# 路线图\n\n| 已发布包 | npm \`latest\` 指向 \`${baseline}\`；兼容用 \`rc\` tag 仍指向 \`${rc}\`。源码可能领先。 | x |\n`,
    'docs/release-notes.md': notes('Release Notes', "What's New", 'Installation', 'Published', 'Hand-written published text.'),
    'docs/release-notes.zh-CN.md': notes('发布说明', '新特性', '安装', '已发布', '手写的已发布说明。'),
  }
}

const plan = (files, r = receipt(), date = DATE) => planEdits(files, r, date)
const changedPaths = (p) => p.report.filter((x) => x.changed).map((x) => x.path).sort()

// ---- arguments ----
eq(parseArgs([]), { receipt: '', root: parseArgs([]).root, date: '', check: false }, 'defaults')
eq(parseArgs(['--check', '--date', '2026-01-02', '--receipt', 'r.json']).check, true)
eq(parseArgs(['--date', '2026-01-02']).date, '2026-01-02')
throws(() => parseArgs(['--date', 'yesterday']), /YYYY-MM-DD/)
throws(() => parseArgs(['--receipt']), /needs a value/)
throws(() => parseArgs(['--receipt', '--check']), /needs a value/)
throws(() => parseArgs(['--nope']), /unknown argument/)

// ---- only a full, passing pull-back may reach the docs ----
assertReceipt(receipt()); checks++
throws(() => assertReceipt({ ...receipt(), schema: 'other' }), /not a verify-published/)
throws(() => assertReceipt(null), /not a verify-published/)
throws(() => assertReceipt(receipt({ ok: false })), /failed pull-back/)
throws(() => assertReceipt(receipt({ cleanRoom: false })), /registry-only/)
throws(() => assertReceipt(receipt({ registry: null })), /lacks version, tag or registry/)
throws(() => assertReceipt(receipt({ registry: { fileCount: 1 } })), /lacks version, tag or registry/)
throws(() => plan(docs(), receipt({ ok: false })), /failed pull-back/)
throws(() => plan(docs(), receipt(), ''), /no usable publish date/)
throws(() => plan(docs(), receipt(), 'soon'), /no usable publish date/)

// ---- a release to `latest` moves every baseline and adds the Published sections ----
{
  const before = docs()
  const p = plan(before)
  ok(!p.errors, `no errors: ${p.errors}`)
  eq(changedPaths(p), Object.keys(before).sort(), 'all eight files change')
  const f = p.files
  ok(f['README.md'].includes(`**v${NEW}** on npm (\`latest\`)`) && f['README.md'].includes(`Version baseline: \`v${NEW}\` (npm \`latest\`)`), 'README (en) baselines')
  ok(f['README.zh-CN.md'].includes(`npm \`latest\`：**v${NEW}**`) && f['README.zh-CN.md'].includes(`版本基线：\`v${NEW}\`（npm \`latest\`）`), 'README (zh) baselines')
  ok(f['docs/user-guide.md'].includes(`\`npx ${NAME}@${NEW} web\``) && f['docs/user-guide.zh-CN.md'].includes(`\`npx ${NAME}@${NEW} web\``), 'user-guide pin example in both languages')
  ok(f['docs/roadmap.md'].includes(`npm \`latest\` points to \`${NEW}\``) && f['docs/roadmap.zh-CN.md'].includes(`npm \`latest\` 指向 \`${NEW}\``), 'roadmap row in both languages')
  for (const [path, old] of Object.entries(f)) {
    if (path.includes('release-notes')) continue
    ok(!old.includes(OLD), `${path} no longer names the previous version`)
    ok(old.replace(/[`*]/g, '').length > 20, `${path} kept its other content`)
  }
  // the text around every edit is untouched
  ok(f['README.md'].endsWith('Gates.\n') && f['README.md'].includes('Pre-1.0.\n\nMore text.'), 'README prose around the edits is untouched')

  const en = f['docs/release-notes.md']
  const zh = f['docs/release-notes.zh-CN.md']
  const section = (text, heading) => text.split('\n').slice(text.split('\n').findIndex((l, i, a) => l === `### ${heading}` && a.slice(0, i).some((x) => x.startsWith(`## v${NEW}`))))
  const enPub = section(en, 'Published').slice(0, 4)
  const zhPub = section(zh, '已发布').slice(0, 4)
  ok(enPub[0] === '### Published' && enPub[1] === '' && enPub[2].startsWith(`Published to npm on ${DATE} as \`${NAME}@${NEW}\``), 'English section is inserted in the new version\'s block')
  ok(zhPub[0] === '### 已发布' && zhPub[2].startsWith(`${DATE} 以 `), 'Chinese section is inserted in the new version\'s block')
  ok(en.indexOf('### Published') < en.indexOf(`## v${OLD}`), 'the section sits before the previous version\'s block, not inside it')
  ok(zh.indexOf('### 已发布') < zh.indexOf(`## v${OLD}`), 'the Chinese section sits before the previous version\'s block')
  ok(en.includes(`### Published\n\n${enPub[2]}\n\n---\n\n## v${OLD}`), 'the section is followed by the block separator')

  // en/zh divergence is a bug: both sections must carry the same facts
  const facts = (text) => new Set([
    ...(text.match(/`[^`]+`/g) ?? []).filter((x) => /[0-9a-f]{40}|@|TAG=|\.\/scripts|npm (view|pack)/.test(x)),
    ...(text.match(/\(https:\/\/[^)]+\)/g) ?? []),
    ...(text.match(/\b\d+ (files|个文件)/g) ?? []).map((x) => x.split(' ')[0]),
  ])
  const enFacts = facts(enPub[2])
  const zhFacts = facts(zhPub[2])
  eq([...enFacts].sort(), [...zhFacts].sort(), 'both languages state the same shasum, command, version and links')
  ok(enFacts.has(`\`${SHA}\``) && enFacts.has('12'), 'the facts include the shasum and the file count')
  ok(enPub[2].includes('`npm pack --dry-run` predicted') && zhPub[2].includes('`npm pack --dry-run` 预测'), 'a build the registry matched is described as predicted')
  ok(enPub[2].includes('compatibility `rc` tag is still on `0.0.1-rc.20`') && zhPub[2].includes('`rc` tag 仍指向 `0.0.1-rc.20`'), 'the rc tag sentence is stated')
  ok(!en.includes('\n\n\n') && !zh.includes('\n\n\n'), 'no double blank lines are introduced')
}

// ---- idempotent: a second run, and a run on already-recorded docs, change nothing ----
{
  const first = plan(docs())
  const second = plan(first.files)
  ok(!second.errors, 'second run recognises its own output')
  eq(changedPaths(second), [], 'a second run changes nothing')
  eq(second.files, first.files, 'and the content is identical')
}

// ---- a hand-written Published section is never overwritten ----
{
  const p = plan(docs({ published: true }))
  eq(changedPaths(p), ['README.md', 'README.zh-CN.md', 'docs/roadmap.md', 'docs/roadmap.zh-CN.md', 'docs/user-guide.md', 'docs/user-guide.zh-CN.md'], 'only the baselines change when the sections already exist')
  ok(p.files['docs/release-notes.md'].includes('Hand-written published text.') && p.files['docs/release-notes.zh-CN.md'].includes('手写的已发布说明。'), 'the hand-written text survives')
}

// ---- a version block that ends the file (no trailing separator) ----
{
  const p = plan(docs({ endOfFile: true }))
  ok(!p.errors, 'a block at the end of the file is found')
  ok(p.files['docs/release-notes.md'].trimEnd().endsWith('GitHub Release: [v0.2.0-rc.21](https://github.com/Danceiny/gotry/releases/tag/v0.2.0-rc.21). The compatibility `rc` tag is still on `0.0.1-rc.20`.'), 'the section is appended after the last block content')
}

// ---- a release to another dist-tag does not move the `latest` baselines ----
{
  const before = docs()
  const p = plan(before, receipt({ tag: 'next', registry: { ...receipt().registry, distTags: { latest: OLD, next: NEW } } }))
  ok(!p.errors, 'a non-latest release plans cleanly')
  eq(changedPaths(p), ['docs/release-notes.md', 'docs/release-notes.zh-CN.md'], 'only the release notes change')
  for (const f of ['README.md', 'README.zh-CN.md', 'docs/user-guide.md', 'docs/roadmap.md']) eq(p.files[f], before[f], `${f} is untouched`)
  ok(p.files['docs/release-notes.md'].includes('shows `next` → `0.2.0-rc.21`') && p.files['docs/release-notes.md'].includes('TAG=next ./scripts/publish-npm.sh'), 'the section names the tag that was used')
}

// ---- the baseline never moves backwards ----
{
  const p = plan(docs({ baseline: '0.2.0-rc.30' }))
  ok(p.errors?.some((e) => e.startsWith('README.md:') && /newer than the receipt/.test(e)), 'a README ahead of the receipt is an error')
  ok(p.errors?.some((e) => e.startsWith('docs/roadmap.md:') && /0\.2\.0-rc\.30/.test(e)), 'so is a roadmap row ahead of it')
  ok(!p.files, 'and nothing is returned to write')
  const same = plan(docs({ baseline: NEW }))
  ok(!same.errors, 'a baseline equal to the receipt is fine (re-run after a partial edit)')
  const stable = plan(docs({ baseline: '0.2.0' }))
  ok(stable.errors?.some((e) => /newer than the receipt/.test(e)), 'a stable release outranks its own prerelease')
}

// ---- an unrecognised shape is reported, never guessed at; nothing is written ----
{
  const drift = (name, mutate, path) => {
    const files = docs()
    files[path] = mutate(files[path])
    const p = plan(files)
    ok(p.errors?.some((e) => e.startsWith(`${path}:`) && /not found/.test(e)), `${name}: reported against ${path}`)
    ok(p.files === undefined && p.report === undefined, `${name}: no partial result`)
  }
  drift('README status line reworded', (t) => t.replace('on npm (`latest`)', 'on the registry'), 'README.md')
  drift('README baseline reworded', (t) => t.replace('Version baseline', 'Baseline'), 'README.md')
  drift('zh README status reworded', (t) => t.replace('npm `latest`：', '最新版：'), 'README.zh-CN.md')
  drift('zh README baseline reworded', (t) => t.replace('版本基线', '基线'), 'README.zh-CN.md')
  drift('user-guide example reworded', (t) => t.replace(' web`', ' start`'), 'docs/user-guide.md')
  drift('zh user-guide example reworded', (t) => t.replace('npx', 'pnpm dlx'), 'docs/user-guide.zh-CN.md')
  drift('roadmap row renamed', (t) => t.replace('Published package', 'Package'), 'docs/roadmap.md')
  drift('zh roadmap row renamed', (t) => t.replace('已发布包', '包'), 'docs/roadmap.zh-CN.md')
  drift('roadmap rc sentence reworded', (t) => t.replace('remains on', 'stays on'), 'docs/roadmap.md')
  const noBlock = plan(docs({ block: false }))
  ok(noBlock.errors?.some((e) => e.startsWith('docs/release-notes.md:') && e.includes(`## v${NEW}`)), 'a release without its notes block is an error: write the release notes first')
  ok(noBlock.errors?.some((e) => e.startsWith('docs/release-notes.zh-CN.md:')), 'and so for the Chinese notes')
  const missing = docs()
  delete missing['docs/roadmap.md']
  ok(plan(missing).errors?.includes('docs/roadmap.md: file missing'), 'a missing file is an error')
}

// ---- the rc tag follows the registry, and is simply left alone when the receipt has none ----
{
  const moved = plan(docs(), receipt({ registry: { ...receipt().registry, distTags: { latest: NEW, rc: '0.2.0-rc.5' } } }))
  ok(moved.files['docs/roadmap.md'].includes('remains on `0.2.0-rc.5`') && moved.files['docs/roadmap.zh-CN.md'].includes('仍指向 `0.2.0-rc.5`'), 'the roadmap follows a moved rc tag in both languages')
  const none = plan(docs(), receipt({ registry: { ...receipt().registry, distTags: { latest: NEW } } }))
  ok(none.files['docs/roadmap.md'].includes('remains on `0.0.1-rc.20`'), 'without an rc tag in the receipt the roadmap sentence is left alone')
  ok(!/compatibility `rc` tag is still/.test(none.files['docs/release-notes.md']), 'and the notes do not mention it')
  const same = plan(docs(), receipt({ registry: { ...receipt().registry, distTags: { latest: NEW, rc: NEW } } }))
  ok(!/compatibility `rc` tag is still/.test(same.files['docs/release-notes.md']), 'an rc tag on the new version needs no "still on" sentence')
  const older = plan(docs(), receipt({ registry: { ...receipt().registry, distTags: undefined } }))
  ok(!older.errors, 'a receipt from before distTags were recorded still plans')
}

// ---- the "predicted" claim needs the registry-matched check ----
{
  const r = receipt({ checks: [{ name: 'registry: version visible', ok: true }, { name: 'registry: matches the pre-publish build', ok: false }] })
  const p = plan(docs(), r)
  ok(!p.files['docs/release-notes.md'].includes('predicted') && !p.files['docs/release-notes.zh-CN.md'].includes('预测'), 'no "predicted" claim when the build match was not proven')
  const none = plan(docs(), receipt({ checks: [] }))
  ok(!none.files['docs/release-notes.md'].includes('predicted'), 'nor when there was no expected-build record')
  const noCount = plan(docs(), receipt({ registry: { shasum: SHA, distTags: { latest: NEW } } }))
  ok(!/\d+ files/.test(noCount.files['docs/release-notes.md']) && !/个文件/.test(noCount.files['docs/release-notes.zh-CN.md']), 'no file count is invented when the registry did not give one')
}

// ---- version strings that look like regex replacement tokens survive ----
{
  const v = '10.0.0'
  const files = docs({ baseline: '9.9.9' })
  for (const k of Object.keys(files)) files[k] = files[k].replaceAll(NEW, v)
  const p = plan(files, receipt({ version: v, registry: { ...receipt().registry, distTags: { latest: v } } }))
  ok(!p.errors, `10.0.0 plans: ${p.errors}`)
  ok(p.files['README.md'].includes('**v10.0.0** on npm') && !p.files['README.md'].includes('v10.0.0.0') && !/\$\d/.test(p.files['README.md']), 'a version starting with digits is not mistaken for a group reference')
}

// ---- the CLI ----
const tmp = mkdtempSync(join(tmpdir(), 'gotry-post-docs-'))
const cli = (root, args, script = SCRIPT) => {
  const r = spawnSync(process.execPath, [script, '--root', root, ...args], { encoding: 'utf8', timeout: 30_000 })
  return { status: r.status, out: `${r.stdout}${r.stderr}` }
}
const write = (root, files) => {
  for (const [p, c] of Object.entries(files)) {
    mkdirSync(dirname(join(root, p)), { recursive: true })
    writeFileSync(join(root, p), c)
  }
}
const readAll = (root, names) => Object.fromEntries(names.map((n) => [n, readFileSync(join(root, n), 'utf8')]))
const receiptFile = join(tmp, 'receipt.json')
writeFileSync(receiptFile, `${JSON.stringify(receipt())}\n`)
{
  const root = join(tmp, 'ok')
  const before = docs()
  write(root, before)
  const names = Object.keys(before)
  const c1 = cli(root, ['--receipt', receiptFile, '--check'])
  eq(c1.status, 1, '--check on docs that are behind exits 1')
  ok(/DOCS ARE BEHIND/.test(c1.out) && /would update docs\/roadmap\.md/.test(c1.out), '--check names what is behind')
  eq(readAll(root, names), before, '--check writes nothing')
  const c2 = cli(root, ['--receipt', receiptFile])
  eq(c2.status, 0, c2.out)
  ok(/updated README\.md/.test(c2.out) && /recorded @scope\/pkg@0\.2\.0-rc\.21 in 8 file/.test(c2.out), 'the run reports what it did')
  eq(readAll(root, names), plan(before).files, 'the files hold exactly the planned content')
  const c3 = cli(root, ['--receipt', receiptFile, '--check'])
  eq(c3.status, 0, '--check after the run exits 0')
  ok(/DOCS ARE UP TO DATE/.test(c3.out), '--check reports up to date')
  const c4 = cli(root, ['--receipt', receiptFile])
  ok(c4.status === 0 && /nothing to do/.test(c4.out), 'a second run is a no-op')
  // the date comes from the receipt, and --date overrides it
  const root2 = join(tmp, 'dated')
  write(root2, before)
  cli(root2, ['--receipt', receiptFile, '--date', '2026-12-25'])
  ok(readFileSync(join(root2, 'docs/release-notes.md'), 'utf8').includes('Published to npm on 2026-12-25'), '--date overrides the receipt date')
  ok(plan(before).files['docs/release-notes.md'].includes(`Published to npm on ${DATE}`), 'the receipt date is the default')
}
{
  // registry-only, failed, absent and corrupt receipts never touch the docs
  const root = join(tmp, 'refuse')
  const before = docs()
  write(root, before)
  const names = Object.keys(before)
  const bad = (name, content) => { const f = join(tmp, name); writeFileSync(f, content); return f }
  const cases = [
    ['registry-only', bad('r1.json', JSON.stringify(receipt({ cleanRoom: false }))), /registry-only/],
    ['failed', bad('r2.json', JSON.stringify(receipt({ ok: false }))), /failed pull-back/],
    ['corrupt', bad('r3.json', '{not json'), /cannot read the receipt/],
    ['absent', join(tmp, 'nope.json'), /run scripts\/verify-published\.mjs first/],
  ]
  for (const [name, file, re] of cases) {
    const r = cli(root, ['--receipt', file])
    eq(r.status, 2, `${name} receipt exits 2`)
    ok(re.test(r.out), `${name} receipt: ${r.out.trim().split('\n')[0]}`)
    ok(!/\n\s+at /.test(r.out), `${name} receipt: no stack trace`)
  }
  eq(readAll(root, names), before, 'no refused receipt wrote anything')
}
{
  // all or none: one unrecognised doc stops the whole set, including the files that were fine
  const root = join(tmp, 'allornone')
  const before = docs()
  before['docs/roadmap.zh-CN.md'] = before['docs/roadmap.zh-CN.md'].replace('已发布包', '包')
  write(root, before)
  const r = cli(root, ['--receipt', receiptFile])
  eq(r.status, 1, 'an unrecognised doc exits 1')
  ok(/docs not recognised — nothing was written/.test(r.out) && /docs\/roadmap\.zh-CN\.md:/.test(r.out), 'the doc is named')
  eq(readAll(root, Object.keys(before)), before, 'none of the eight files was written')
}
{
  // a directory where a doc should be is reported as a missing file, not a stack trace
  const root = join(tmp, 'dir')
  const before = docs()
  delete before['docs/user-guide.md']
  write(root, before)
  mkdirSync(join(root, 'docs/user-guide.md'))
  const r = cli(root, ['--receipt', receiptFile])
  ok(r.status === 1 && /docs\/user-guide\.md: file missing/.test(r.out) && !/\n\s+at /.test(r.out), 'a directory in place of a doc is reported cleanly')
}
{
  // reached through a symlinked directory (macOS /tmp and /var are symlinks), the script must still run
  const real = join(tmp, 'real')
  mkdirSync(join(real, 'scripts'), { recursive: true })
  for (const f of ['post-release-docs.mjs', 'release-lib.mjs']) copyFileSync(join(HERE, f), join(real, 'scripts', f))
  symlinkSync(real, join(tmp, 'link'))
  const root = join(tmp, 'viasym')
  write(root, docs())
  const r = cli(root, ['--receipt', receiptFile], join(tmp, 'link', 'scripts', 'post-release-docs.mjs'))
  ok(r.status === 0 && /recorded @scope\/pkg@0\.2\.0-rc\.21/.test(r.out), `a symlinked script path still runs main: ${r.out.slice(0, 120)}`)
}
{
  const r = spawnSync(process.execPath, [SCRIPT, '--bogus'], { encoding: 'utf8' })
  ok(r.status === 2 && /unknown argument --bogus/.test(r.stderr) && /usage: node scripts\/post-release-docs\.mjs/.test(r.stderr), 'a bad flag prints usage and exits 2')
}
rmSync(tmp, { recursive: true, force: true })

// ---- drift guard: this checkout's real docs must stay recognisable ----
{
  const root = join(HERE, '..')
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  const names = Object.keys(docs())
  const files = Object.fromEntries(names.map((n) => [n, readFileSync(join(root, n), 'utf8')]))
  const p = planEdits(files, receipt({ name: pkg.name, version: pkg.version, registry: { shasum: SHA, fileCount: 1, distTags: { latest: pkg.version } } }), DATE)
  ok(!p.errors, `post-release-docs.mjs no longer recognises the real docs — update its patterns together with the docs:\n${(p.errors ?? []).join('\n')}`)
  ok(p.report.length === 8, 'the real docs yield a plan for all eight files')
}

console.log(`POST-RELEASE-DOCS TESTS: ${checks} checks OK`)
