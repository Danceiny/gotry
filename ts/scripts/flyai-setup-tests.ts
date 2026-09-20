/**
 * FlyAI setup CLI 离线回归(issue #521)。
 *
 * 所有用例使用隔离 HOME/DSH_HOME/cwd 与本地 fake verifier；不会读取真实凭据，
 * 也不会请求供应商 API。覆盖 setup 写入、权限、回执绑定、脱敏及失败回滚。
 */

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const repoRoot = join(import.meta.dirname, '..', '..')
const bootstrap = join(repoRoot, 'bin', 'gotry-bootstrap.js')
const sandbox = mkdtempSync(join(tmpdir(), 'gotry-flyai-setup-'))
const fakeVerifier = join(sandbox, 'fake-flyai-cli.js')
writeFileSync(fakeVerifier, `#!/usr/bin/env node
if (process.env.FAKE_FLYAI_RESULT === 'auth-error') {
  process.stderr.write('HTTP 401 Invalid API key')
  process.exit(1)
}
if (process.env.FAKE_FLYAI_RESULT === 'leak-403' || process.env.FAKE_FLYAI_RESULT === 'leak-exit') {
  process.stderr.write((process.env.FAKE_FLYAI_RESULT === 'leak-403' ? 'HTTP 403 ' : 'upstream failed ') + process.env.FLYAI_API_KEY + ' ' + process.env.DEBUG_FLYAI_MCP_URL)
  process.exit(1)
}
process.stdout.write(JSON.stringify({ data: { itemList: [] } }))
`)
chmodSync(fakeVerifier, 0o700)

// package-shaped outer entry: no .git, no repository .env, only the runtime files
// that the npm package exposes for `gotry setup ...` dispatch.
const packageFixture = join(sandbox, 'package-shaped')
mkdirSync(join(packageFixture, 'bin'), { recursive: true })
for (const file of ['gotry-inner.js', 'gotry-bootstrap.js', 'gotry-process-liveness.js', 'gotry-runtime-resolution.js']) {
  copyFileSync(join(repoRoot, 'bin', file), join(packageFixture, 'bin', file))
}
writeFileSync(join(packageFixture, 'package.json'), JSON.stringify({ type: 'module', version: 'test' }) + '\n')
const packageEntry = join(packageFixture, 'bin', 'gotry-inner.js')

const key = 'sk-fake-setup-key-1234'
const oldKey = 'sk-old-setup-key-0000'
const baseEnv = (home: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv => ({
  PATH: process.env.PATH ?? '',
  HOME: home,
  DSH_HOME: join(home, '.dsh'),
  GOTRY_FLYAI_CLI_BIN: fakeVerifier,
  GOTRY_FLYAI_VERIFY_TIMEOUT_MS: '5000',
  ...extra,
})

function run(home: string, args: string[], input = '', extra: Record<string, string> = {}) {
  return spawnSync('node', [bootstrap, ...args], {
    cwd: sandbox,
    env: baseEnv(home, extra),
    input,
    encoding: 'utf8',
    timeout: 15_000,
  })
}

function runPackageEntry(home: string, args: string[], input = '', extra: Record<string, string> = {}) {
  return spawnSync('node', [packageEntry, ...args], {
    cwd: sandbox,
    env: baseEnv(home, extra),
    input,
    encoding: 'utf8',
    timeout: 15_000,
  })
}

function configPath(home: string) { return join(home, '.flyai', 'config.json') }
function receiptPath(home: string) { return join(home, '.gotry', 'flyai-verification.json') }
function mode(path: string) { return statSync(path).mode & 0o777 }
function writeConfig(home: string, value: unknown) {
  mkdirSync(join(home, '.flyai'), { recursive: true, mode: 0o700 })
  writeFileSync(configPath(home), `${typeof value === 'string' ? value : JSON.stringify(value)}\n`, { mode: 0o600 })
  chmodSync(join(home, '.flyai'), 0o700)
  chmodSync(configPath(home), 0o600)
}

// 1. fresh HOME: real setup entry accepts a local successful verifier and writes secure files.
const firstHome = mkdtempSync(join(sandbox, 'first-'))
const first = run(firstHome, ['setup', 'flyai', '--stdin'], `${key}\n`)
assert.equal(first.status, 0, first.stdout + first.stderr)
assert.equal(mode(join(firstHome, '.flyai')), 0o700)
assert.equal(mode(configPath(firstHome)), 0o600)
assert.equal(mode(join(firstHome, '.gotry')), 0o700)
assert.equal(mode(receiptPath(firstHome)), 0o600)
const firstReceipt = JSON.parse(readFileSync(receiptPath(firstHome), 'utf8')) as Record<string, unknown>
assert.equal(firstReceipt.source, 'config')
assert.equal(typeof firstReceipt.endpointFingerprint, 'string')
assert.equal('endpoint' in firstReceipt, false, 'receipt 不应保存 endpoint 明文')
assert.ok(!first.stdout.includes(key), 'stdout 不得回显 key')
console.log('1. fresh setup + 0700/0600 + fingerprint receipt OK')

const packageHome = mkdtempSync(join(sandbox, 'package-entry-'))
const packageRun = runPackageEntry(packageHome, ['setup', 'flyai', '--stdin'], `${key}\n`)
assert.equal(packageRun.status, 0, packageRun.stdout + packageRun.stderr)
assert.equal(JSON.parse(readFileSync(configPath(packageHome), 'utf8')).FLYAI_API_KEY, key)
assert.ok(!packageRun.stdout.includes(key), 'outer package entry 不得回显 key')
console.log('1b. package-shaped bin/gotry-inner.js → setup flyai dispatch OK')

// 2. an ambient env key cannot be claimed as the candidate's verified source.
const envOverrideHome = mkdtempSync(join(sandbox, 'env-override-'))
const envOverride = run(envOverrideHome, ['setup', 'flyai', '--stdin'], `${key}\n`, { FLYAI_API_KEY: oldKey })
assert.equal(envOverride.status, 0, envOverride.stdout + envOverride.stderr)
const envOverrideReceipt = JSON.parse(readFileSync(receiptPath(envOverrideHome), 'utf8')) as Record<string, unknown>
assert.equal(envOverrideReceipt.source, 'config')
const envOverrideStatus = run(envOverrideHome, ['setup', 'flyai', '--status'], '', { FLYAI_API_KEY: oldKey })
assert.equal(envOverrideStatus.status, 0)
assert.ok(envOverrideStatus.stdout.includes('已配置,未验证'))
console.log('2. ambient env override cannot forge candidate source binding OK')

// 3. endpoint output is redacted; status rejects source and full endpoint changes.
const debugHome = mkdtempSync(join(sandbox, 'debug-'))
const debug = run(debugHome, ['setup', 'flyai', '--stdin'], `${key}\n`, {
  DEBUG_FLYAI_MCP_URL: 'https://user:query-secret@example.test/mcp?token=first-secret',
})
assert.equal(debug.status, 0, debug.stdout + debug.stderr)
assert.ok(!debug.stdout.includes('query-secret') && !debug.stdout.includes('first-secret') && !debug.stdout.includes('user:'), debug.stdout)
const debugReceipt = JSON.parse(readFileSync(receiptPath(debugHome), 'utf8')) as Record<string, unknown>
assert.equal(debugReceipt.endpointDebug, true)
const sourceMismatch = JSON.stringify({ ...debugReceipt, source: 'env' }, null, 2) + '\n'
writeFileSync(receiptPath(debugHome), sourceMismatch, { mode: 0o600 })
const sourceStatus = run(debugHome, ['setup', 'flyai', '--status'], '', {
  DEBUG_FLYAI_MCP_URL: 'https://user:query-secret@example.test/mcp?token=first-secret',
})
assert.equal(sourceStatus.status, 0)
assert.ok(sourceStatus.stdout.includes('未按当前来源/endpoint 验证'))
const correctReceipt = JSON.stringify({ ...debugReceipt, source: 'config' }, null, 2) + '\n'
writeFileSync(receiptPath(debugHome), correctReceipt, { mode: 0o600 })
const matchingStatus = run(debugHome, ['setup', 'flyai', '--status'], '', {
  DEBUG_FLYAI_MCP_URL: 'https://user:query-secret@example.test/mcp?token=first-secret',
})
assert.equal(matchingStatus.status, 0)
assert.ok(matchingStatus.stdout.includes('验证: 已验证'))
const pathStatus = run(debugHome, ['setup', 'flyai', '--status'], '', {
  DEBUG_FLYAI_MCP_URL: 'https://user:query-secret@example.test/changed?token=first-secret',
})
assert.equal(pathStatus.status, 0)
assert.ok(pathStatus.stdout.includes('未按当前来源/endpoint 验证'))
const queryStatus = run(debugHome, ['setup', 'flyai', '--status'], '', {
  DEBUG_FLYAI_MCP_URL: 'https://user:query-secret@example.test/mcp?token=second-secret',
})
assert.equal(queryStatus.status, 0)
assert.ok(queryStatus.stdout.includes('未按当前来源/endpoint 验证'))
assert.ok(!pathStatus.stdout.includes('first-secret') && !queryStatus.stdout.includes('second-secret') && !queryStatus.stdout.includes('user:'), queryStatus.stdout)
console.log('3. source/path/query mismatch + endpoint output redaction OK')

// 4. malformed config and verifier failure preserve the old bytes/key.
const badHome = mkdtempSync(join(sandbox, 'bad-json-'))
writeConfig(badHome, `${key} broken json`)
const badBefore = readFileSync(configPath(badHome))
const bad = run(badHome, ['setup', 'flyai', '--stdin'], `${key}\n`)
assert.notEqual(bad.status, 0)
assert.ok(!(bad.stdout + bad.stderr).includes(key), 'JSON parse errors must not quote credential bytes')
assert.deepEqual(readFileSync(configPath(badHome)), badBefore)

const verifyFailHome = mkdtempSync(join(sandbox, 'verify-fail-'))
writeConfig(verifyFailHome, { FLYAI_API_KEY: oldKey, keep: 'yes' })
const verifyBefore = readFileSync(configPath(verifyFailHome))
const verifyFail = run(verifyFailHome, ['setup', 'flyai', '--stdin'], `${key}\n`, { FAKE_FLYAI_RESULT: 'auth-error' })
assert.notEqual(verifyFail.status, 0)
assert.deepEqual(readFileSync(configPath(verifyFailHome)), verifyBefore)
assert.ok(verifyFail.stdout.includes('配置未改动'))
console.log('4. bad JSON + verifier failure preserve old config bytes/key OK')

// 5. receipt write failure is visible and rolls back the newly attempted key.
const receiptFailHome = mkdtempSync(join(sandbox, 'receipt-fail-'))
writeConfig(receiptFailHome, { FLYAI_API_KEY: oldKey, keep: 'yes' })
mkdirSync(join(receiptFailHome, '.gotry'), { mode: 0o755 })
chmodSync(join(receiptFailHome, '.gotry'), 0o755)
const receiptFail = run(receiptFailHome, ['setup', 'flyai', '--stdin'], `${key}\n`)
assert.notEqual(receiptFail.status, 0)
assert.ok(receiptFail.stdout.includes('验证回执写入失败'))
assert.equal(JSON.parse(readFileSync(configPath(receiptFailHome), 'utf8')).FLYAI_API_KEY, oldKey)
console.log('5. receipt write failure reports non-success and preserves old key OK')

// The verifier may echo its input credentials. Public diagnostics must not.
for (const failure of ['leak-403', 'leak-exit']) {
  const result = run(verifyFailHome, ['setup', 'flyai', '--stdin'], `${key}\n`, {
    FAKE_FLYAI_RESULT: failure,
    DEBUG_FLYAI_MCP_URL: 'https://private-user:private-password@example.test/mcp?token=private-token',
  })
  assert.notEqual(result.status, 0)
  const output = result.stdout + result.stderr
  for (const secret of [key, 'private-user', 'private-password', 'private-token']) assert.ok(!output.includes(secret), failure)
  assert.deepEqual(readFileSync(configPath(verifyFailHome)), verifyBefore)
}
console.log('6. upstream stderr cannot leak candidate credentials or endpoint secrets OK')
