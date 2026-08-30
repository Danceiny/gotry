/**
 * CHANGELOG 生成器合同测试(run-all §42;2026-08-30 owner 拍板补 changelog 机制)。
 * 纯函数、零网络、零 git 调用:
 *   - Conventional Commits 解析:feat/fix/perf/refactor/docs/test/build/ci/chore/revert + scope + ! + PR 引用
 *   - 不符合 Conventional 的 commit → other 桶(不丢历史)
 *   - groupCommits 按 Keep a Changelog 显示顺序输出
 *   - renderMarkdownEntry 节结构(Added/Changed/Fixed/...)
 *   - prependEntry:不覆盖 CHANGELOG.md 历史段,只在顶部插入新版本段
 *   - splitChangelog:preamble/history 分隔正确
 */

import assert from 'node:assert/strict'
import {
  buildEntry,
  groupCommits,
  parseCommit,
  prependEntry,
  renderMarkdownEntry,
  splitChangelog,
  type ParsedCommit,
} from './build-changelog.ts'

let passed = 0
function ok(label: string): void {
  passed += 1
  console.log(`  ok ${label}`)
}

// ---- 1. parseCommit:Conventional 完整形态 ----
const sample = parseCommit('feat(cost): 价表 provider-aware v2 + 价格漂移监测 (#68)')
assert.ok(sample)
assert.equal(sample!.type, 'feat')
assert.equal(sample!.scope, 'cost')
assert.equal(sample!.subject, '价表 provider-aware v2 + 价格漂移监测')
assert.equal(sample!.prRef, '68')
ok('parseCommit feat(scope)! + #PR')

// ---- 2. parseCommit:不带 scope ----
const noScope = parseCommit('fix: 修复登录页可见性')
assert.equal(noScope!.type, 'fix')
assert.equal(noScope!.scope, null)
assert.equal(noScope!.subject, '修复登录页可见性')
assert.equal(noScope!.prRef, null)
ok('parseCommit fix 无 scope')

// ---- 3. parseCommit:不符合 Conventional → other 桶,保留原文 ----
const other = parseCommit('docs: README 更新')
assert.equal(other!.type, 'docs')
const legacy = parseCommit('feat(issue #21 P3.6): 会话扩展 onboarding UX 闭环(点点点 + 装完零重跑)')
assert.equal(legacy!.type, 'feat')
assert.equal(legacy!.scope, 'issue #21 P3.6')
const historical = parseCommit('Merge branch main into feat/x')
assert.equal(historical!.type, 'other')
assert.equal(historical!.subject, 'Merge branch main into feat/x')
ok('parseCommit 历史 commit + 中文 subject + 无 #PR 兼容')

// ---- 4. parseCommit:perf/refactor/docs/test/build/ci/chore/revert 全覆盖 ----
for (const t of ['perf', 'refactor', 'docs', 'test', 'build', 'ci', 'chore', 'revert'] as const) {
  const p = parseCommit(`${t}: 一些改动`)
  assert.equal(p!.type, t)
}
ok('parseCommit 全 9 类型支持')

// ---- 5. groupCommits:Keep a Changelog 显示顺序 ----
const commits: ParsedCommit[] = [
  { sha: 'aaa', type: 'fix', scope: null, subject: 'fix bug', prRef: '1', raw: '' },
  { sha: 'bbb', type: 'feat', scope: null, subject: 'add feature', prRef: '2', raw: '' },
  { sha: 'ccc', type: 'docs', scope: null, subject: 'update docs', prRef: null, raw: '' },
  { sha: 'ddd', type: 'other', scope: null, subject: 'random commit', prRef: null, raw: '' },
]
const grouped = groupCommits(commits)
assert.equal(grouped.length, 4)
assert.equal(grouped[0]!.type, 'feat')
assert.equal(grouped[1]!.type, 'fix')
assert.equal(grouped[2]!.type, 'docs')
assert.equal(grouped[3]!.type, 'other')
ok('groupCommits Keep a Changelog 显示顺序(Added → Fixed → Documentation → Other)')

// ---- 6. renderMarkdownEntry:节结构 + PR 引用 + sha 后缀 ----
// 用较长 subject 避开 truncate 逻辑(短 subject 仍可能触发 breaker,断言用「包含」而非「完全等」)
const entry = buildEntry({ version: '0.0.1-rc.16', date: '2026-08-30', commits: [
  { sha: 'aaa', type: 'feat', scope: null, subject: 'add a brand new feature with substantial description text', prRef: '2', raw: '' },
  { sha: 'bbb', type: 'fix', scope: null, subject: 'fix a critical bug in the rendering path of the parser', prRef: '1', raw: '' },
  { sha: 'ccc', type: 'docs', scope: null, subject: 'update the documentation for the new auth module', prRef: null, raw: '' },
] })
const md = renderMarkdownEntry(entry)
assert.match(md, /^## \[0\.0\.1-rc\.16\] - 2026-08-30/)
assert.match(md, /### Added/)
assert.match(md, /### Fixed/)
assert.match(md, /### Documentation/)
assert.match(md, /- add a brand new feature[^()]*\(#2\)/)
assert.match(md, /- fix a critical bug[^()]*\(#1\)/)
assert.match(md, /- update the documentation[^()]*\(ccc\)/) // sha 后缀(无 PR)
ok('renderMarkdownEntry 节结构 + PR/sha 后缀')

// ---- 7. prependEntry:不覆盖 CHANGELOG.md 历史段 ----
const existing = `# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.0.1-rc.15] - 2026-08-29

### Added
- 预订 saga 状态机
`
const newMd = renderMarkdownEntry(entry)
const next = prependEntry(existing, newMd)
assert.match(next, /## \[0\.0\.1-rc\.16\] - 2026-08-30/)
assert.match(next, /## \[0\.0\.1-rc\.15\] - 2026-08-29/)
assert.match(next, /预订 saga 状态机/)
ok('prependEntry:新版本段在顶部,历史段原样保留')

// ---- 8. prependEntry:空文件 → 仅生成 CHANGELOG header + 新段 ----
const fromEmpty = prependEntry('', newMd)
assert.match(fromEmpty, /Keep a Changelog/)
assert.match(fromEmpty, /## \[0\.0\.1-rc\.16\]/)
ok('prependEntry:空文件首次生成')

// ---- 9. splitChangelog:preamble 与 history 分割 ----
const split = splitChangelog(existing)
assert.ok(split.preamble.includes('All notable changes'))
assert.ok(split.history[0]!.includes('## [0.0.1-rc.15]'))
ok('splitChangelog preamble/history 分隔正确')

// ---- 10. buildEntry 空 sections 不崩(空 commit 列表)----
const emptyEntry = buildEntry({ version: '0.0.1-rc.16', date: '2026-08-30', commits: [] })
const emptyMd = renderMarkdownEntry(emptyEntry)
assert.match(emptyMd, /## \[0\.0\.1-rc\.16\]/)
ok('buildEntry 空 commit 列表 → 仍输出版本头(0 section,合规)')

// ---- 11. parseCommit:! 标记(breaking change)----
const breaking = parseCommit('feat(api)!: 重命名端点 /v1/users → /v2/users (#99)')
assert.equal(breaking!.type, 'feat')
assert.equal(breaking!.subject, '重命名端点 /v1/users → /v2/users')
assert.equal(breaking!.prRef, '99')
ok('parseCommit feat(scope)!: breaking change marker 容错')

console.log(`changelog tests: ${passed} 组断言全绿(纯函数)`)