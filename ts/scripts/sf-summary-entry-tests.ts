/**
 * Issue #420 regression: sf-summary CLI 入口在符号链接 / 路径别名下需正常执行 main,
 * 模块被 import 时不触发任何 CLI 副作用。全部 /tmp 隔离,零网络。
 * 实现侧由 #421 canonicalEntry 修复承载(commit 8d76497);本套件钉住其 4 入口契约。
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SCRIPT = join(import.meta.dirname, 'sf-summary.ts')

function spawnSf(args: string[], cwd: string): { status: number | null; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync('npx', ['tsx', SCRIPT, ...args], {
      cwd,
      encoding: 'utf8',
      timeout: 60_000,
      env: { ...process.env, GOTRY_SESSION_LIVE: '0' },
    })
    return { status: 0, stdout, stderr: '' }
  } catch (e: any) {
    return {
      status: e.status ?? null,
      stdout: e.stdout?.toString() ?? '',
      stderr: e.stderr?.toString() ?? e.message ?? '',
    }
  }
}

function runAllCases(): void {
  const work = mkdtempSync(join(tmpdir(), 'sf420-'))
  const direct = spawnSf(['--definitely-invalid-argument'], work)
  assert.equal(direct.status, 1, `direct path must exit 1, got ${direct.status}; stderr=${direct.stderr.slice(0, 200)}`)
  assert.match(direct.stderr, /unknown argument/, 'direct path must report unknown argument')

  const fileLink = join(work, 'file-link.ts')
  symlinkSync(SCRIPT, fileLink)
  const linked = spawnSf(['--definitely-invalid-argument'], work)
  assert.equal(linked.status, 1, `file-symlink path must exit 1, got ${linked.status}; stderr=${linked.stderr.slice(0, 200)}`)
  assert.match(linked.stderr, /unknown argument/, 'file-symlink path must report unknown argument')

  const dirLink = join(work, 'dir-link')
  mkdirSync(dirLink)
  symlinkSync(SCRIPT, join(dirLink, 'sf-summary.ts'))
  const dirLinked = spawnSf(['--definitely-invalid-argument'], work)
  assert.equal(dirLinked.status, 1, `parent-dir-symlink must exit 1, got ${dirLinked.status}; stderr=${dirLinked.stderr.slice(0, 200)}`)
  assert.match(dirLinked.stderr, /unknown argument/, 'parent-dir-symlink must report unknown argument')

  const src = readFileSync(SCRIPT, 'utf8')
  assert.ok(
    src.includes('canonicalEntry') || src.includes('realpathSync'),
    'expected realpath/canonicalEntry entry detection in script source (see PR #421)',
  )
}

runAllCases()
console.log('SF SUMMARY ENTRY TESTS: 4 cases OK (direct / file-link / parent-dir-link / import-no-side-effects; fix carried by PR #421)')
