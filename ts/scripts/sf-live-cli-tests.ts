import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'

const tsxCli = join(import.meta.dirname, '..', 'node_modules', 'tsx', 'dist', 'cli.mjs')
const runner = join(import.meta.dirname, 'sf-live-benchmark.ts')

const unknown = spawnSync(process.execPath, [tsxCli, runner, '--golden=ctrip-open'], {
  cwd: join(import.meta.dirname, '..'),
  encoding: 'utf8',
  timeout: 5_000,
})
assert.equal(unknown.status, 1, `未知 vendor 应在网络调用前 exit 1，实际 status=${unknown.status} error=${unknown.error?.message ?? '-'}`)
assert.match(unknown.stderr, /不支持的 golden vendor: ctrip-open/)
assert.equal(unknown.stdout.includes('sf-01 上海→丽江'), false, 'fail-closed 前不得启动任何 query')

console.log('SF LIVE CLI TESTS: unknown vendor fail-closed before network OK')
