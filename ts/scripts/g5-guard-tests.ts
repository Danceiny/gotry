/**
 * G5 机械闸自测(issue #348;全离线,零网络,零共享 state 写入)。
 *
 * 覆盖:
 *  1. (17) pattern 命中/不命中双向——真桥接形状(G5_BRIDGE/g5Bridge/
 *     capability-travel-mcp/t-system bridge/G5桥)必须命中;承运人代码
 *     G5/G52667、persona-bench 案例 G5、base64 噪声、「提到 G5 门」的
 *     门定义句必须不命中(误报会把 tracker 自身打红);
 *  2. (7) 台账解析——GRANT 缺 issue/决策链接 → 拒收(fail closed);
 *     code fence 内模板行不计入;glob 语义(** 跨段 / * 单段);覆盖判定;
 *  3. (2) 命名面豁免存在(master-outline 对 + 台账/guard 对);
 *  4. (4) CLI 端到端(临时 git fixture,--root 注入):未授权引用 → exit 1
 *     且输出可操作指引;GRANT 覆盖后 → exit 0;干净仓 → exit 0;
 *     台账缺失 → exit 2(闸自身不可用,而非放行)。
 *
 * 运行:cd ts && npx tsx scripts/g5-guard-tests.ts
 */

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { globToRegExp, grantCovers, parseGrants, scanContent, NAMING_SURFACES } from './g5-guard.ts'

let assertions = 0
function ok(value: unknown, message: string): void {
  assert.ok(value, message)
  assertions += 1
}

// ── 1. pattern 命中/不命中双向 ──────────────────────────────────────────────
const mustHit: Array<[string, string]> = [
  ['env key', 'G5_BRIDGE_ENDPOINT=https://internal.example'],
  ['camelCase identifier', 'const g5Bridge = createBridge()'],
  ['hyphen path', 'see ts/src/adapters/g5-bridge/client.ts'],
  ['internal MCP plugin id', 'registerPlugin("capability-travel-mcp")'],
  ['t-system bridge', 't-system bridge adapter for flights'],
  ['bridge adjacent t-system', 'BridgeTSystem flights'],
  ['chinese adjacency', '启用 G5 桥'],
  ['chinese bridge g5', '桥 G5 工具'],
  ['chinese t-system prefix', '桥接 T 系统 的机票工具'],
  ['chinese t-system suffix', 'T 系统适配层'],
]
for (const [label, text] of mustHit) {
  ok(scanContent('fixture.ts', text).length === 1, `pattern 应命中: ${label} (${text})`)
}
const mustNotHit: Array<[string, string]> = [
  ['carrier code', '{ "carrier_codes": ["CA", "CZ", "G5", "GS"] }'],
  ['flight number', '"known_flights": ["G52667", "CZ5817"]'],
  ['persona-bench case id', '| G5 | 万xx 指代 | = 甲米 |'],
  ['gate mention without bridge adjacency', 'constrained by G5); ② reference'],
  ['gate row phrase', 'G5 (internal travel bridge approval)'],
  ['base64-ish noise', '"integrity": "sha512-mQ+/0Fo3LTIX+4k3m+P4y9e9IA6/BeNHrWW19U+G5x0Z8BlybHDELZIB=="'],
  ['zh gate row phrase', '内部差旅工具桥（T 系统侧，脱敏）的内部审批'],
]
for (const [label, text] of mustNotHit) {
  ok(scanContent('fixture.ts', text).length === 0, `pattern 不应命中(误报): ${label} (${text})`)
}

// ── 2. 台账解析 + glob 语义 ────────────────────────────────────────────────
const empty = parseGrants('# G5 Authorization Ledger\n\n(empty)\n')
ok(empty.grants.length === 0 && empty.malformed === 0, '空台账应解析为 0 授权')

const noLink = parseGrants('- GRANT: src/** — some bridge\n')
ok(noLink.grants.length === 0 && noLink.malformed === 1, '缺 issue/决策链接的 GRANT 应被拒收(fail closed)')

const ledger = parseGrants([
  '# ledger',
  '- GRANT: src/adapters/** — masked flight reads, tenant X — issue: #348',
  '- GRANT: docs/notes.md — demo — decision: https://example/decision',
].join('\n'))
ok(ledger.grants.length === 2 && ledger.malformed === 0, '带 issue/决策链接的 GRANT 应成立')
ok(grantCovers(ledger.grants[0], 'src/adapters/flight/client.ts'), '`**` 应跨段覆盖')
ok(!grantCovers(ledger.grants[0], 'docs/notes.md'), '不匹配的路径不应被覆盖')

const withTemplate = parseGrants([
  '# ledger',
  '```',
  '- GRANT: <path-glob> — system/purpose/scope one-liner — issue/decision: #<n> or URL',
  '```',
  '- GRANT: src/** — real entry — issue: #348',
].join('\n'))
ok(withTemplate.grants.length === 1 && withTemplate.malformed === 0, 'code fence 内的模板行不应计入 GRANT/畸形')

const single = globToRegExp('docs/*.md')
ok(single.test('docs/a.md') && !single.test('docs/sub/b.md'), '`*` 应限单段')

// ── 3. 命名面豁免 ──────────────────────────────────────────────────────────
ok(NAMING_SURFACES.has('docs/gotry-master-outline.md') && NAMING_SURFACES.has('docs/gotry-master-outline.zh-CN.md'), '门定义对必须在命名面')
ok(NAMING_SURFACES.has('docs/g5-authorization-ledger.md') && NAMING_SURFACES.has('ts/scripts/g5-guard.ts'), '台账与 guard 自身必须在命名面')

// ── 4. CLI 端到端(临时 git fixture) ───────────────────────────────────────
const tsRoot = join(import.meta.dirname, '..')
const guardScript = join(tsRoot, 'scripts', 'g5-guard.ts')
const tsxBin = join(tsRoot, 'node_modules', '.bin', 'tsx')

function makeFixture(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'g5-guard-fixture-'))
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, rel)
    mkdirSync(join(abs, '..'), { recursive: true })
    writeFileSync(abs, content)
  }
  spawnSync('git', ['init', '-q'], { cwd: root })
  spawnSync('git', ['add', '-A'], { cwd: root })
  return root
}

function runGuard(root: string): { status: number; stdout: string; stderr: string } {
  const result = spawnSync(tsxBin, [guardScript, '--root', root], { encoding: 'utf8' })
  return { status: result.status ?? -1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

const LEDGER_HEADER = [
  '# G5 Authorization Ledger',
  '',
  '## Entries',
  '',
  '(empty)',
  '',
].join('\n')

// 红:未授权桥接引用 → exit 1 + 可操作指引
const redRoot = makeFixture({
  'src/adapter.ts': 'export const endpoint = process.env.G5_BRIDGE_ENDPOINT\n',
  'docs/README.md': 'docs index\n',
  'docs/g5-authorization-ledger.md': LEDGER_HEADER,
})
const red = runGuard(redRoot)
ok(red.status === 1 && red.stderr.includes('src/adapter.ts') && red.stderr.includes('issues/348'), `未授权引用应 exit 1 且给出路径与 #348 指引(status=${red.status}, stderr=${red.stderr.slice(0, 200)})`)

// 绿:创始人侧 GRANT 覆盖后 → exit 0(fixture 内的 GRANT 仅演示解析,非真实授权)
writeFileSync(join(redRoot, 'docs', 'g5-authorization-ledger.md'), LEDGER_HEADER + '- GRANT: src/** — fixture demo only, not a real grant — issue: #348\n')
const green = runGuard(redRoot)
ok(green.status === 0, `GRANT 覆盖后应 exit 0(status=${green.status}, stderr=${green.stderr.slice(0, 200)})`)
rmSync(redRoot, { recursive: true, force: true })

// 绿:干净仓(无任何引用)→ exit 0
const cleanRoot = makeFixture({ 'src/adapter.ts': 'export const endpoint = "https://api.hotelbyte.example"\n', 'docs/g5-authorization-ledger.md': LEDGER_HEADER })
ok(runGuard(cleanRoot).status === 0, '干净仓应 exit 0')
rmSync(cleanRoot, { recursive: true, force: true })

// exit 2:台账缺失 → 闸不可用,而不是放行
const noLedgerRoot = makeFixture({ 'src/adapter.ts': 'export const x = 1\n' })
ok(runGuard(noLedgerRoot).status === 2, '台账缺失应 exit 2(闸配置错误),不得放行')
rmSync(noLedgerRoot, { recursive: true, force: true })

console.log(`G5 GUARD TESTS: ${assertions}/${assertions} OK(命中/不命中双向 / 台账 fail-closed+glob / 命名面 / CLI 红绿+exit2)`)
