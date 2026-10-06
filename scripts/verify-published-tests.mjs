#!/usr/bin/env node
/**
 * Tests for scripts/verify-published.mjs.
 *
 * The registry is a local HTTP server and the script runs as a subprocess in --registry-only mode, inside a
 * temporary copy of its own directory layout (so its receipt handling cannot touch this checkout). The clean-room
 * part (npx doctor / web / one-shot) needs the real registry and several minutes; it is proven by running the script
 * against a published version, and its pure decision helpers are covered here.
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { EXPECTED_FILE, VERIFIED_FILE } from './release-lib.mjs'
import { cleanRoomEnv, compareExpected, hasStackTrace, parseArgs } from './verify-published.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
let checks = 0
const ok = (cond, msg) => { assert.ok(cond, msg); checks++ }
const eq = (a, b, msg) => { assert.deepEqual(a, b, msg); checks++ }

// ---- pure helpers ----
ok(hasStackTrace('Error: boom\n    at Object.<anonymous> (/x/y.js:10:5)\n    at Module._compile (node:internal/modules/cjs/loader:1:1)'), 'a Node stack frame is detected')
ok(hasStackTrace('    at file:///x/y.mjs:3:9'), 'an anonymous frame is detected')
ok(!hasStackTrace('dsh: MISSING_CREDENTIAL: llm-deepseek: no API key for provider route "deepseek-official"'), 'a host error is not a stack trace')
ok(!hasStackTrace('Looking at 12:30 flights (budget 3000)'), 'prose containing "at" and a time is not a stack trace')

const dist = { shasum: 'a'.repeat(40), integrity: 'sha512-xyz', fileCount: 543, unpackedSize: 100 }
eq(compareExpected(dist, null), [], 'no record, nothing to compare')
eq(compareExpected(dist, { shasum: dist.shasum, integrity: dist.integrity, fileCount: 543, unpackedSize: 100 }), [])
eq(compareExpected({ ...dist, shasum: 'b'.repeat(40) }, { shasum: dist.shasum }).length, 1, 'a different shasum is a problem')
eq(compareExpected({ ...dist, fileCount: 600 }, { fileCount: 543 }).length, 1, 'a different file count is a problem')
eq(compareExpected({ shasum: dist.shasum }, { shasum: dist.shasum, fileCount: 543 }), [], 'the abbreviated packument may lack the counts; the shasum still binds')

process.env.DEEPSEEK_API_KEY = 'sk-should-not-leak'
process.env.LLM_API_KEY = 'sk-should-not-leak'
const room = mkdtempSync(join(tmpdir(), 'gotry-verify-env-'))
const env = cleanRoomEnv(room, 'https://registry.npmjs.org/')
ok(!JSON.stringify(env).includes('sk-should-not-leak'), 'the clean-room environment inherits no LLM key')
ok(env.HOME.startsWith(room) && env.npm_config_cache.startsWith(room), 'HOME and the npm cache are fresh')
eq(env.npm_config_userconfig, '/dev/null', 'no user .npmrc')
eq(env.npm_config_registry, 'https://registry.npmjs.org/', 'the registry is explicit')
rmSync(room, { recursive: true, force: true })

eq(parseArgs(['0.2.0-rc.28', '--tag', 'latest', '--doctor-absent', 'a', '--doctor-absent', 'b']).doctorAbsent, ['a', 'b'])
assert.throws(() => parseArgs(['1', '2']), /at most one version/); checks++
assert.throws(() => parseArgs(['--wait', '-1']), /--wait/); checks++
assert.throws(() => parseArgs(['--poll', '0']), /--poll/); checks++

// ---- the CLI against a fake registry ----
const NAME = '@scope/pkg'
const VERSION = '1.0.0'
const tarball = Buffer.from('not really a tarball, but the bytes are what is hashed')
const sha1 = createHash('sha1').update(tarball).digest('hex')
const integrity = `sha512-${createHash('sha512').update(tarball).digest('base64')}`

const state = { hits: 0, notFoundFirst: 0, packument: null, tarball }
const server = createServer((req, res) => {
  if (req.url === '/tarball.tgz') { res.end(state.tarball); return }
  if (req.url === '/@scope%2fpkg') {
    state.hits++
    if (state.hits <= state.notFoundFirst || state.packument === null) { res.statusCode = 404; res.end('{}'); return }
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify(state.packument))
    return
  }
  res.statusCode = 404
  res.end()
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const registry = `http://127.0.0.1:${server.address().port}/`

const packument = (over = {}) => ({
  name: NAME,
  'dist-tags': { latest: VERSION, ...(over.tags ?? {}) },
  versions: { [VERSION]: { name: NAME, version: VERSION, dist: { shasum: sha1, integrity, tarball: `${registry}tarball.tgz`, fileCount: 3, unpackedSize: 99, ...(over.dist ?? {}) } } },
})

// a temporary root with the scripts' own layout, so the receipt logic runs against files we can inspect
const root = mkdtempSync(join(tmpdir(), 'gotry-verify-root-'))
mkdirSync(join(root, 'scripts'))
for (const f of ['verify-published.mjs', 'release-lib.mjs']) copyFileSync(join(HERE, f), join(root, 'scripts', f))
writeFileSync(join(root, 'package.json'), JSON.stringify({ name: NAME, version: VERSION }))
const expectedFile = join(root, EXPECTED_FILE)
const verifiedFile = join(root, VERIFIED_FILE)

function cli(args, scriptRoot = root) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [join(scriptRoot, 'scripts/verify-published.mjs'), ...args], { cwd: root, env: { ...process.env, NO_COLOR: '1' } })
    let out = ''
    child.stdout.on('data', (d) => { out += d })
    child.stderr.on('data', (d) => { out += d })
    child.on('close', (code) => resolve({ code, out }))
  })
}
const base = ['--registry', registry, '--registry-only', '--wait', '0', '--poll', '1']
const reset = (over = {}) => {
  state.hits = 0
  state.notFoundFirst = 0
  state.tarball = tarball
  state.packument = packument(over)
  rmSync(expectedFile, { force: true })
}
const expectRecord = (over = {}) => writeFileSync(expectedFile, JSON.stringify({ name: NAME, version: VERSION, tag: 'latest', shasum: sha1, integrity, fileCount: 3, unpackedSize: 99, ...over }))

// happy path, with the pre-publish record
reset()
expectRecord()
let r = await cli(base)
eq(r.code, 0, `happy path exits 0\n${r.out}`)
ok(r.out.includes('registry: matches the pre-publish build') && r.out.includes('tarball: bytes'), `registry facts and tarball bytes are both checked\n${r.out}`)
ok(r.out.includes('REGISTRY CHECKS PASSED') && r.out.includes('not the pull-back'), 'a registry-only pass says it is not the pull-back')
ok(!existsSync(verifiedFile), 'a registry-only pass never writes the receipt post-release-docs trusts')

// an explicit --json receipt is written even for registry-only, marked as such
reset()
expectRecord()
const receiptPath = join(root, 'receipt.json')
r = await cli([...base, '--json', receiptPath])
const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'))
eq([receipt.schema, receipt.ok, receipt.cleanRoom, receipt.version, receipt.tag], ['gotry_release_verified_v1', true, false, VERSION, 'latest'], 'the receipt says it was registry-only')
eq(receipt.registry.distTags, { latest: VERSION }, 'the receipt carries the dist-tags the registry reported')

// without a record it still verifies the registry's own consistency, and says it skipped the build comparison
reset()
r = await cli([VERSION, '--tag', 'latest', ...base])
eq(r.code, 0, r.out)
ok(r.out.includes('skipped (no expected-build record)'), 'a missing record is stated, not hidden')

// a stale receipt from an earlier release is removed up front
writeFileSync(verifiedFile, JSON.stringify({ ok: true, version: '0.0.1' }))
reset()
expectRecord()
r = await cli(base)
ok(!existsSync(verifiedFile), 'a stale receipt cannot satisfy a new run')

// version not on the registry (never published, or not propagated yet)
reset()
expectRecord()
state.packument = { name: NAME, 'dist-tags': { latest: '0.9.0' }, versions: {} }
r = await cli(base)
eq(r.code, 1)
ok(r.out.includes('do NOT call it published'), 'a missing version forbids the word "published"')
ok(!r.out.includes('tarball: bytes'), 'nothing downstream runs on a missing version')

// package missing entirely
reset()
expectRecord()
state.packument = null
r = await cli(base)
eq(r.code, 1)

// dist-tag not moved
reset({ tags: { latest: '0.9.0' } })
expectRecord()
r = await cli(base)
eq(r.code, 1)
ok(r.out.includes('latest → 0.9.0, expected 1.0.0'), 'a dist-tag left behind is named')

// the registry serves a different build than the one recorded before publishing
reset({ dist: { shasum: 'e'.repeat(40) } })
expectRecord()
r = await cli(base)
eq(r.code, 1)
ok(r.out.includes('≠ expected'), 'a shasum different from the recorded build is a failure')

// downloaded bytes do not hash to what the registry advertises
reset()
expectRecord()
state.tarball = Buffer.from('tampered')
r = await cli(base)
eq(r.code, 1)
ok(r.out.includes('tarball: bytes') && r.out.includes('differ from the registry'), 'tampered or truncated bytes fail the tarball check')

// propagation delay: the first requests see nothing, then the version appears
reset()
expectRecord()
state.notFoundFirst = 2
r = await cli(['--registry', registry, '--registry-only', '--wait', '20', '--poll', '1'])
eq(r.code, 0, r.out)
ok(/version visible — @scope\/pkg@1\.0\.0 \(after [1-9]\d*s\)/.test(r.out), 'a registry that needs a few seconds is waited for, and the wait is reported')

// usage and consistency errors exit 2, not 1
reset()
r = await cli(['--registry', registry, '--registry-only'])
eq(r.code, 2, 'no version and no record is a usage error')
expectRecord({ version: '9.9.9' })
r = await cli([VERSION, '--tag', 'latest', ...base])
eq(r.code, 2, 'a record for another version is refused')
ok(r.out.includes('9.9.9'), 'and says which version the record is for')

// reaching the script through a symlinked directory must still run it: Node reports the real path in import.meta.url
// but keeps argv[1] as typed, and a plain comparison silently exits 0 without verifying anything (macOS /tmp, /var)
reset()
expectRecord()
const link = `${root}-link`
symlinkSync(root, link)
r = await cli(base, link)
eq(r.code, 0, `through a symlinked path\n${r.out}`)
ok(r.out.includes('pull-back:'), `the script really ran when reached through a symlink\n${r.out}`)
rmSync(link, { force: true })

server.close()
rmSync(root, { recursive: true, force: true })
console.log(`VERIFY-PUBLISHED TESTS: ${checks} checks OK`)
