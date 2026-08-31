#!/usr/bin/env node
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const builder = join(root, 'scripts/build-booking-copilot-release.mjs')
const contract = process.env.BOOKING_COPILOT_RELEASE_CONTRACT
  || (process.env.HOTEL_BE_ROOT ? join(process.env.HOTEL_BE_ROOT, 'build/deploy/gotry-booking-copilot/release-contract.sh') : '')
for (const name of ['EXPECTED_GOTRY_ARTIFACT_ID', 'EXPECTED_GOTRY_RELEASE_TUPLE', 'EXPECTED_NODE_VERSION', 'EXPECTED_NPM_VERSION']) {
  assert.ok(process.env[name], `${name} is required`)
}
if (contract) {
  assert.ok(existsSync(contract), `release contract does not exist: ${contract}`)
  assert.ok(process.env.EXPECTED_BOOKING_COPILOT_RELEASE_CONTRACT_SHA256, 'EXPECTED_BOOKING_COPILOT_RELEASE_CONTRACT_SHA256 is required when a BE contract is provided')
  assert.equal(createHash('sha256').update(readFileSync(contract)).digest('hex'), process.env.EXPECTED_BOOKING_COPILOT_RELEASE_CONTRACT_SHA256)
}
const node24 = process.env.NODE24_BIN || process.execPath
const allowedEnv = [
  'PATH', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'CI',
  'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy',
]
const baseEnv = Object.fromEntries(allowedEnv.filter((key) => process.env[key]).map((key) => [key, process.env[key]]))
baseEnv.PATH = `${dirname(node24)}${delimiter}${process.env.PATH || ''}`
const version = spawnSync(node24, ['--version'], { encoding: 'utf8', env: baseEnv })
assert.equal(version.status, 0, version.stderr)
assert.match(version.stdout.trim(), /^v24\./, `release builder test must run with Node24 (got ${version.stdout.trim()})`)
assert.equal(version.stdout.trim(), process.env.EXPECTED_NODE_VERSION)
assert.equal(process.platform, 'linux', 'authoritative release gate requires Linux glibc')
assert.ok(['x64', 'arm64'].includes(process.arch))
assert.equal(process.env.EXPECTED_GOTRY_RELEASE_TUPLE, `linux-${process.arch}-glibc`)
const artifactId = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', env: baseEnv }).stdout.trim()
assert.equal(artifactId, process.env.EXPECTED_GOTRY_ARTIFACT_ID)
const npmProbe = spawnSync('npm', ['--version'], { encoding: 'utf8', env: baseEnv })
assert.equal(npmProbe.status, 0, npmProbe.stderr)
const npmVersion = npmProbe.stdout.trim()
assert.equal(npmVersion, process.env.EXPECTED_NPM_VERSION)
const committedBuilder = spawnSync('git', ['show', `${artifactId}:scripts/build-booking-copilot-release.mjs`], { cwd: root, env: baseEnv })
assert.equal(committedBuilder.status, 0, 'builder must exist in HEAD before release execution')
assert.deepEqual(readFileSync(builder), committedBuilder.stdout, 'executing builder must equal the committed HEAD builder')

const tempRoots = []
const temp = () => { const path = mkdtempSync(join(tmpdir(), 'gotry-builder-test-')); tempRoots.push(path); return path }
const files = (root, dir = root) => readdirSync(dir).sort().flatMap((name) => { const path = join(dir, name); const stat = lstatSync(path); return stat.isDirectory() ? files(root, path) : [path.slice(root.length + 1)] })
function verifyManifest(root) {
  const listed = readFileSync(join(root, 'MANIFEST.sha256'), 'utf8').trim().split('\n').map((line) => {
    const match = line.match(/^([0-9a-f]{64})  (.+)$/); assert.ok(match, `malformed manifest line: ${line}`)
    const path = match[2]; assert.ok(path && !path.startsWith('/') && !path.split('/').includes('..') && !/[\s]/.test(path), `unsafe manifest path: ${path}`)
    assert.notEqual(path, 'MANIFEST.sha256'); return [path, match[1]]
  })
  const actual = files(root).filter((path) => path !== 'MANIFEST.sha256').sort()
  assert.deepEqual(listed.map(([path]) => path).sort(), actual)
  for (const [path, expected] of listed) assert.equal(createHash('sha256').update(readFileSync(join(root, path))).digest('hex'), expected, path)
}
try {
  const expectedEnv = {
    ...baseEnv,
    EXPECTED_GOTRY_ARTIFACT_ID: process.env.EXPECTED_GOTRY_ARTIFACT_ID,
    EXPECTED_GOTRY_RELEASE_TUPLE: process.env.EXPECTED_GOTRY_RELEASE_TUPLE,
    EXPECTED_NODE_VERSION: process.env.EXPECTED_NODE_VERSION,
    EXPECTED_NPM_VERSION: process.env.EXPECTED_NPM_VERSION,
    BOOKING_COPILOT_NPM_CACHE: join(temp(), 'npm-cache'),
    GOTRY_SECRET_CANARY: `canary-${Date.now()}-${Math.random()}`,
  }
  if (process.env.NON_NODE24_BIN) {
    const negative = spawnSync(process.env.NON_NODE24_BIN, [builder, join(temp(), 'negative')], { encoding: 'utf8', env: expectedEnv })
    assert.notEqual(negative.status, 0)
    assert.match(negative.stderr, /Node 24 is required/)
  }
  const output = join(temp(), 'release')
  const result = spawnSync(node24, [builder, output], { cwd: root, env: expectedEnv, encoding: 'utf8', timeout: 300000 })
  assert.equal(result.status, 0, result.stderr || result.stdout)
  const release = JSON.parse(result.stdout.trim())
  assert.equal(release.artifactId, process.env.EXPECTED_GOTRY_ARTIFACT_ID)
  assert.equal(release.releaseTuple, process.env.EXPECTED_GOTRY_RELEASE_TUPLE)
  assert.equal(release.nodeVersion, process.env.EXPECTED_NODE_VERSION)
  assert.equal(release.npmVersion, process.env.EXPECTED_NPM_VERSION)
  assert.equal(readFileSync(join(output, 'ARTIFACT_ID'), 'utf8').trim(), process.env.EXPECTED_GOTRY_ARTIFACT_ID)
  const provenance = JSON.parse(readFileSync(join(output, 'BUILD_PROVENANCE.json'), 'utf8'))
  assert.deepEqual(provenance, {
    schemaVersion: 'gotry.booking-copilot.release-provenance.v1',
    bookingSurfaceSchemaVersion: 'booking.surface.v1',
    artifactId: process.env.EXPECTED_GOTRY_ARTIFACT_ID,
    platform: 'linux',
    arch: process.arch,
    libc: 'glibc',
    libcVersion: process.report.getReport().header.glibcVersionRuntime,
    nodeVersion: process.env.EXPECTED_NODE_VERSION,
    npmVersion: process.env.EXPECTED_NPM_VERSION,
    releaseTuple: process.env.EXPECTED_GOTRY_RELEASE_TUPLE,
  })
  for (const path of files(output)) assert.equal(readFileSync(join(output, path)).includes?.(expectedEnv.GOTRY_SECRET_CANARY) || false, false, path)
  if (contract) {
    const check = spawnSync('bash', ['-c', 'source "$1"; booking_copilot_validate_release "$2"', '_', contract, output], { encoding: 'utf8', env: baseEnv })
    assert.equal(check.status, 0, check.stderr || check.stdout)
  } else console.log('BE contract: SKIP (no BOOKING_COPILOT_RELEASE_CONTRACT or HOTEL_BE_ROOT)')
  verifyManifest(output)
  const manifestText = readFileSync(join(output, 'MANIFEST.sha256'), 'utf8')
  assert.doesNotMatch(manifestText, /\.worktree\.env|\.env(?:\.|$)|(?:^|\/)secrets?(?:[._/-]|$)/i)
  const output2 = join(temp(), 'release')
  const result2 = spawnSync(node24, [builder, output2], { cwd: root, env: expectedEnv, encoding: 'utf8', timeout: 300000 })
  assert.equal(result2.status, 0, result2.stderr || result2.stdout)
  const manifest1 = readFileSync(join(output, 'MANIFEST.sha256'))
  const manifest2 = readFileSync(join(output2, 'MANIFEST.sha256'))
  assert.deepEqual(manifest1, manifest2, 'same HEAD must produce identical manifest bytes')
  assert.equal(createHash('sha256').update(manifest1).digest('hex'), createHash('sha256').update(manifest2).digest('hex'))
  verifyManifest(output2)
  const distText = readFileSync(join(output, 'dist/src/booking-surface/startup.js'), 'utf8')
  assert.doesNotMatch(distText, /sourceURL=(?:file:\/\/)?\/(?:Users|private|var|tmp)\//i, 'dist must not contain an absolute sourceURL')
  assert.equal(distText.includes(root), false, 'dist must not contain an absolute build root')
  const stateRoot = temp()
  const child = spawn(node24, [join(output, 'bin/gotry-booking-copilot.js')], {
    cwd: output,
    env: {
      ...baseEnv,
      HOME: temp(),
      GOTRY_BOOKING_COPILOT_API_KEY: 'fixture-key',
      DEEPSEEK_API_KEY: 'fixture-model-key',
      GOTRY_BOOKING_COPILOT_STATE_ROOT: stateRoot,
      GOTRY_BOOKING_COPILOT_HOST: '127.0.0.1',
      GOTRY_BOOKING_COPILOT_PORT: '0',
    },
  })
  const exit = new Promise((resolve) => child.once('exit', (code, signal) => resolve(code ?? signal)))
  let stderr = ''
  child.stderr.on('data', (chunk) => { stderr += chunk.toString() })
  const deadline = Date.now() + 30000
  let port = 0
  while (Date.now() < deadline && !port && child.exitCode === null) {
    const match = stderr.match(/listening on http:\/\/127\.0\.0\.1:(\d+)\/a2a\/booking-copilot\/turn/)
    if (match) port = Number(match[1]); else await new Promise((resolve) => setTimeout(resolve, 100))
  }
  try {
    assert.ok(port > 0, `artifact did not start: ${stderr}`)
    const response = await fetch(`http://127.0.0.1:${port}/healthz`, {
      headers: { Authorization: 'Bearer fixture-key' },
      signal: AbortSignal.timeout(5_000),
    })
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('x-booking-surface-version'), 'booking.surface.v1')
    assert.equal(response.headers.get('x-booking-surface-schema-sha256'), 'd9c2194ec839bd1168e70e8a201581addc005039d9b299660e20650bbb65df81')
    assert.equal(response.headers.get('x-gotry-artifact-id'), process.env.EXPECTED_GOTRY_ARTIFACT_ID)
    assert.deepEqual(await response.json(), { schemaSha256: 'd9c2194ec839bd1168e70e8a201581addc005039d9b299660e20650bbb65df81', schemaVersion: 'booking.surface.v1', status: 'ready' })
  } finally {
    if (child.exitCode === null) child.kill('SIGTERM')
    const stopped = await Promise.race([
      exit,
      new Promise((resolve) => setTimeout(() => resolve('timeout'), 10_000)),
    ])
    if (stopped === 'timeout' && child.exitCode === null) {
      child.kill('SIGKILL')
      await exit
    }
    assert.equal(stopped, 0, `artifact did not stop cleanly: ${stopped}`)
  }
  const finalHead = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', env: baseEnv }).stdout.trim()
  assert.equal(finalHead, process.env.EXPECTED_GOTRY_ARTIFACT_ID, 'HEAD changed during release proof')
  console.log(`BOOKING COPILOT RELEASE BUILDER: PASS (${release.artifactId}, ${release.files} files, ${release.bytes} bytes; contract/startup/health/SIGTERM PASS)`)
} finally {
  for (const path of tempRoots) rmSync(path, { recursive: true, force: true })
}
