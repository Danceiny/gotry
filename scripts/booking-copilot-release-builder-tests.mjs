#!/usr/bin/env node
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
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
const gitArgs = ['-c', `safe.directory=${root}`]
const version = spawnSync(node24, ['--version'], { encoding: 'utf8', env: baseEnv })
assert.equal(version.status, 0, version.stderr)
assert.match(version.stdout.trim(), /^v24\./, `release builder test must run with Node24 (got ${version.stdout.trim()})`)
assert.equal(version.stdout.trim(), process.env.EXPECTED_NODE_VERSION)
assert.equal(process.platform, 'linux', 'authoritative release gate requires Linux glibc')
assert.ok(['x64', 'arm64'].includes(process.arch))
assert.equal(process.env.EXPECTED_GOTRY_RELEASE_TUPLE, `linux-${process.arch}-glibc`)
const headProbe = spawnSync('git', [...gitArgs, 'rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', env: baseEnv })
assert.equal(headProbe.status, 0, headProbe.stderr)
const artifactId = headProbe.stdout.trim()
assert.equal(artifactId, process.env.EXPECTED_GOTRY_ARTIFACT_ID)
const npmProbe = spawnSync('npm', ['--version'], { encoding: 'utf8', env: baseEnv })
assert.equal(npmProbe.status, 0, npmProbe.stderr)
const npmVersion = npmProbe.stdout.trim()
assert.equal(npmVersion, process.env.EXPECTED_NPM_VERSION)
const committedBuilder = spawnSync('git', [...gitArgs, 'show', `${artifactId}:scripts/build-booking-copilot-release.mjs`], { cwd: root, env: baseEnv })
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
    nodeModulesAbi: process.versions.modules,
    npmVersion: process.env.EXPECTED_NPM_VERSION,
    releaseTuple: process.env.EXPECTED_GOTRY_RELEASE_TUPLE,
  })
  for (const path of files(output)) assert.equal(readFileSync(join(output, path)).includes?.(expectedEnv.GOTRY_SECRET_CANARY) || false, false, path)
  if (contract) {
    const check = spawnSync('bash', ['-c', 'source "$1"; booking_copilot_validate_release "$2"', '_', contract, output], { encoding: 'utf8', env: baseEnv })
    assert.equal(check.status, 0, check.stderr || check.stdout)
  } else console.log('BE contract: SKIP (no BOOKING_COPILOT_RELEASE_CONTRACT or HOTEL_BE_ROOT)')
  verifyManifest(output)
  assert.equal(
    createHash('sha256').update(readFileSync(join(output, 'schemas/booking.surface.v2.schema.json'))).digest('hex'),
    '45df62db1b19d30a4fd22ddc94eb550e8ff32d8a225558b5ff13ba303588fc03',
  )
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
    assert.equal(response.headers.get('x-gotry-node-version'), process.env.EXPECTED_NODE_VERSION)
    assert.equal(response.headers.get('x-gotry-node-modules-abi'), process.versions.modules)
    assert.equal(response.headers.get('x-gotry-release-tuple'), process.env.EXPECTED_GOTRY_RELEASE_TUPLE)
    assert.equal(response.headers.get('x-gotry-glibc-version'), process.report.getReport().header.glibcVersionRuntime)
    assert.equal(response.headers.get('x-gotry-ingress-mode'), 'bff-bound-turn-only')
    assert.equal(response.headers.get('x-gotry-accepted-turn-kinds'), 'user.turn,action.receipt.continuation')
    assert.deepEqual(await response.json(), {
      schemaSha256: 'd9c2194ec839bd1168e70e8a201581addc005039d9b299660e20650bbb65df81',
      schemaVersion: 'booking.surface.v1',
      status: 'ready',
      supportedSchemaVersions: ['booking.surface.v1', 'booking.surface.v2'],
      ingressMode: 'bff-bound-turn-only',
      acceptedTurnKinds: ['user.turn', 'action.receipt.continuation'],
    })
    const v2Headers = {
      Authorization: 'Bearer fixture-key',
      'content-type': 'application/json',
      accept: 'application/json',
      'x-booking-surface-version': 'booking.surface.v2',
      'x-booking-surface-schema-sha256': '45df62db1b19d30a4fd22ddc94eb550e8ff32d8a225558b5ff13ba303588fc03',
    }
    const ingressResponse = await fetch(`http://127.0.0.1:${port}/a2a/booking-copilot/turn`, {
      method: 'POST',
      headers: v2Headers,
      body: JSON.stringify({
        schemaVersion: 'booking.surface.v2',
        kind: 'user.turn.ingress',
        requestKey: 'release-browser-request',
        surfaceHint: 'tenant',
        workspace: {
          schemaVersion: 'booking.surface.v2',
          revision: 0,
          locale: 'en-US',
          currency: 'AED',
          searchDraft: {},
          results: { status: 'idle' },
          visibleHotels: [],
          loadedOffers: [],
          shortlistedOfferRefs: [],
        },
        request: { text: 'release ingress must be BFF-bound' },
      }),
      signal: AbortSignal.timeout(5_000),
    })
    assert.equal(ingressResponse.status, 503)
    assert.deepEqual(await ingressResponse.json(), {
      error: {
        code: 'trusted_ingress_binding_required',
        mode: 'bff-bound-turn-only',
        acceptedTurnKinds: ['user.turn', 'action.receipt.continuation'],
      },
    })
    const releaseLedgerEventCount = () => {
      const count = spawnSync(node24, ['--input-type=module', '-e', "import Database from 'better-sqlite3'; const db = new Database(process.argv[1], { readonly: true }); process.stdout.write(String(db.prepare('SELECT COUNT(*) AS count FROM events').get().count)); db.close()", join(stateRoot, 'gotry-state/gotry-state.db')], { cwd: output, encoding: 'utf8' })
      assert.equal(count.status, 0, count.stderr)
      return count.stdout.trim()
    }
    assert.equal(releaseLedgerEventCount(), '0', 'rejected release ingress creates no ledger event')
    const escalatedBoundTurnResponse = await fetch(`http://127.0.0.1:${port}/a2a/booking-copilot/turn`, {
      method: 'POST',
      headers: v2Headers,
      body: JSON.stringify({
        schemaVersion: 'booking.surface.v2',
        kind: 'user.turn',
        taskId: 'release-escalated-task',
        turnId: 'release-escalated-turn',
        workspace: {
          schemaVersion: 'booking.surface.v2',
          contextRef: 'release-escalated-context',
          surface: 'storefront',
          revision: 0,
          locale: 'en-US',
          currency: 'AED',
          searchDraft: {},
          results: { status: 'idle' },
          visibleHotels: [],
          loadedOffers: [],
          shortlistedOfferRefs: [],
          capabilities: { surface: 'storefront', allowedActions: ['order.observe'] },
        },
        request: { text: 'must remain within the storefront capability matrix' },
      }),
      signal: AbortSignal.timeout(5_000),
    })
    assert.equal(escalatedBoundTurnResponse.status, 403)
    assert.deepEqual(await escalatedBoundTurnResponse.json(), { error: { code: 'invalid_bound_turn_authority' } })
    assert.equal(releaseLedgerEventCount(), '0', 'surface-disallowed bound turn creates no ledger event')
    const boundTurnResponse = await fetch(`http://127.0.0.1:${port}/a2a/booking-copilot/turn`, {
      method: 'POST',
      headers: v2Headers,
      body: JSON.stringify({
        schemaVersion: 'booking.surface.v2',
        kind: 'user.turn',
        taskId: 'release-bound-task',
        turnId: 'release-bound-turn',
        workspace: {
          schemaVersion: 'booking.surface.v2',
          contextRef: 'release-bound-context',
          surface: 'tenant',
          revision: 0,
          locale: 'en-US',
          currency: 'AED',
          searchDraft: {},
          results: { status: 'idle' },
          visibleHotels: [],
          loadedOffers: [],
          shortlistedOfferRefs: [],
          capabilities: { surface: 'tenant', allowedActions: ['search.run'] },
        },
        request: { text: 'BFF-bound internal turn' },
      }),
      signal: AbortSignal.timeout(10_000),
    })
    assert.equal(boundTurnResponse.status, 200, 'bound internal user.turn is not rejected by the ingress seam')
    const boundTurnBody = await boundTurnResponse.text()
    assert.doesNotMatch(boundTurnBody, /trusted_ingress_binding_required/)
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
    assert.equal(stopped, 0, `artifact did not stop cleanly: ${stopped}; stderr: ${stderr}`)
  }
  const finalHeadProbe = spawnSync('git', [...gitArgs, 'rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', env: baseEnv })
  assert.equal(finalHeadProbe.status, 0, finalHeadProbe.stderr)
  const finalHead = finalHeadProbe.stdout.trim()
  assert.equal(finalHead, process.env.EXPECTED_GOTRY_ARTIFACT_ID, 'HEAD changed during release proof')
  console.log(`BOOKING COPILOT RELEASE BUILDER: PASS (${release.artifactId}, ${release.files} files, ${release.bytes} bytes; BE contract ${contract ? 'PASS' : 'SKIP'}; startup/health/SIGTERM PASS)`)
} finally {
  for (const path of tempRoots) rmSync(path, { recursive: true, force: true })
}
