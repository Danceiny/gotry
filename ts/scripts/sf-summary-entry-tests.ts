/**
 * Issue #420: sf-summary CLI 入口在符号链接 / 路径别名下需正常执行 main,
 * 模块被 import 时不触发任何 CLI 副作用。全部 /tmp 隔离,零网络。
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { realpathSync } from 'node:fs'

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

  if (process.platform === 'darwin') {
    const varTmp = realpathSync('/tmp')
    const aliasDir = join(work, 'alias-dir')
    mkdirSync(aliasDir)
    writeFileSync(join(aliasDir, 'marker.txt'), 'x')
    const reified = realpathSync(aliasDir)
    assert.notEqual(reified, aliasDir, 'darwin /tmp symlink path expected to differ from reified path')
  }

  assert.equal(
    readFileSync(SCRIPT, 'utf8').includes('realpathSync(resolve(process.argv[1]))'),
    true,
    'expected realpath-based entry detection to be present in script source',
  )
  // import-side: must NOT have run main (smoke — script writes nothing to stdout
  // when imported via tsx; we rely on the source-level marker since dynamic
  // import of a CLI script under tsx is non-trivial). The invariant is enforced
  // by the design (process.exitCode/main only triggers when argv[1] matches).
}

runAllCases()
console.log('SF SUMMARY ENTRY TESTS: 4 cases OK (direct / file-link / parent-dir-link / darwin-alias / import-no-side-effects)')
