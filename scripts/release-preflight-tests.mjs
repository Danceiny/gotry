#!/usr/bin/env node
/**
 * Tests for scripts/release-lib.mjs and scripts/release-preflight.mjs.
 *
 * Git is real (temporary repositories with a bare "origin"); GitHub and the registry are injected, so the whole
 * suite is offline and deterministic. The cases are the ways a release has actually gone wrong or nearly did:
 * publishing from a checkout that is not the tag (HEAD drift), a tag that never reached the remote (gh release
 * create --verify-tag then fails after npm already published), a commit that never went through main, CI proof
 * that was cancelled by concurrency (rc.28) or is red, and a version that is already on the registry. The npm-publish
 * workflow adds two more: its own "Release: …" check runs must never count as CI, and its gate packs the real tarball.
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { RELEASE_CHECK_PREFIX, compareSemver, looksLikeSecret, parseSemver, redact } from './release-lib.mjs'
import { findCiProof, judgeCheckRuns, parseArgs, parseRepo, runPreflight, writeExpected } from './release-preflight.mjs'

let checks = 0
const ok = (cond, msg) => { assert.ok(cond, msg); checks++ }
const eq = (a, b, msg = `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`) => { assert.deepEqual(a, b, msg); checks++ }

// ---- release-lib: semver precedence (a downgrade guard that mis-orders prereleases would block or allow wrongly) ----
eq(parseSemver('1.2'), null, 'not a semver')
eq(compareSemver('0.2.0-rc.28', '0.2.0-rc.27'), 1, 'rc.28 > rc.27')
eq(compareSemver('0.2.0-rc.9', '0.2.0-rc.10'), -1, 'numeric identifiers compare as numbers, not text')
eq(compareSemver('0.2.0', '0.2.0-rc.28'), 1, 'a release is newer than its prereleases')
eq(compareSemver('0.0.1-rc.20', '0.2.0-rc.28'), -1, 'lower core wins regardless of prerelease')
eq(compareSemver('0.2.0-rc.28', '0.2.0-rc.28'), 0, 'equal')
eq(compareSemver('1.0.0-alpha', '1.0.0-alpha.1'), -1, 'a shorter prerelease set is lower')
eq(compareSemver('1.0.0-alpha.1', '1.0.0-alpha.beta'), -1, 'numeric identifiers sort below alphanumeric')
eq(compareSemver('x', '1.0.0'), null, 'not comparable')
eq(redact('dsh web: http://127.0.0.1:3080/?token=abc-123_DEF ok'), 'dsh web: http://127.0.0.1:3080/?token=<redacted> ok', 'login tokens never reach a log')
eq(RELEASE_CHECK_PREFIX, 'Release: ', 'the prefix the workflow\'s job names and the CI proof agree on')
ok(looksLikeSecret(`npm notice token ${'npm_'}${'a1B2'.repeat(9)}`), 'an npm token shape is a secret')
ok(looksLikeSecret(`Bearer ${'eyJhbGciOiJSUzI1NiJ9'}.${'eyJzdWIiOiJyZXBvIn0'}.${'c2lnbmF0dXJlLWJ5dGVz'}`), 'a JWT shape is a secret')
ok(!looksLikeSecret('npm verbose oidc Successfully retrieved and set token\nhttp fetch PUT 200 https://registry.npmjs.org/@danceiny%2fgotry 812ms'), 'ordinary verbose npm output is not')
ok(!looksLikeSecret('npm_config_registry=https://registry.npmjs.org/ and eyJ is a prefix'), 'a short npm_ word or a bare eyJ is not')

// ---- argument parsing ----
eq(parseArgs(['--tag', 'latest']).tag, 'latest')
assert.throws(() => parseArgs([]), /--tag is required/); checks++
assert.throws(() => parseArgs(['--tag']), /needs a value/); checks++
assert.throws(() => parseArgs(['--tag', 'latest', '--nope']), /unknown argument/); checks++
eq(parseArgs(['--tag', 'latest', '--skip-ci-proof', 'gh offline']).skipCiProof, 'gh offline')
ok(parseArgs(['--tag', 'rc', '--registry', 'http://127.0.0.1:1']).registry.endsWith('/'), 'registry gets a trailing slash')
eq(parseArgs(['--tag', 'latest', '--write-expected', '--pack-dir', '/tmp/bundle']).packDir, '/tmp/bundle')
assert.throws(() => parseArgs(['--tag', 'latest', '--pack-dir', '/tmp/bundle']), /only goes with --write-expected/); checks++

// ---- repository detection from a remote URL ----
eq(parseRepo('git@github.com:Danceiny/gotry.git'), 'Danceiny/gotry')
eq(parseRepo('https://github.com/Danceiny/gotry'), 'Danceiny/gotry')
eq(parseRepo('git+https://github.com/Danceiny/gotry.git'), 'Danceiny/gotry')
eq(parseRepo('/tmp/local/origin.git'), '', 'a local path is not a GitHub repository')

// ---- check-run verdicts ----
const run = (name, status, conclusion) => ({ name, status, conclusion })
eq(judgeCheckRuns([]).state, 'none')
eq(judgeCheckRuns([run('a', 'completed', 'success'), run('b', 'completed', 'skipped')]).state, 'success')
eq(judgeCheckRuns([run('a', 'completed', 'success'), run('b', 'in_progress', '')]).state, 'pending')
eq(judgeCheckRuns([run('a', 'completed', 'success'), run('b', 'completed', 'failure')]).state, 'failed')
eq(judgeCheckRuns([run('a', 'completed', 'success'), run('b', 'completed', 'timed_out')]).state, 'failed')
eq(judgeCheckRuns([run('a', 'completed', 'cancelled'), run('b', 'completed', 'success')]).state, 'incomplete', 'concurrency cancellation is not a failure, and not a proof either')
eq(judgeCheckRuns([run('a', 'completed', 'skipped')]).state, 'none', 'nothing ran is not green')

// ---- CI proof against a fake gh ----
/** A fake `gh api` keyed on the endpoint; the --jq program is ignored and the canned TSV is returned. */
function fakeGh(table) {
  const calls = []
  const gh = (args) => {
    const endpoint = args.find((a) => a.startsWith('repos/')) ?? ''
    calls.push(endpoint)
    const hit = table[endpoint]
    if (hit === undefined) return { status: 1, stdout: '', stderr: `HTTP 404 ${endpoint}` }
    return { status: 0, stdout: hit, stderr: '' }
  }
  gh.calls = calls
  return gh
}
const SHA = 'a'.repeat(40)
const HEAD_SHA = 'b'.repeat(40)
const TREE = 'c'.repeat(40)
const green = 'CI\tcompleted\tsuccess\nlint\tcompleted\tsuccess\n'
const cancelled = 'CI\tcompleted\tcancelled\n'

let proof = findCiProof({ repo: 'o/r', sha: SHA, tree: TREE, tagName: 'v1', gh: fakeGh({ [`repos/o/r/commits/${SHA}/check-runs`]: green }) })
ok(proof.ok && /commit aaaaaaaa/.test(proof.detail), 'the tag commit\'s own green checks are the proof')

proof = findCiProof({ repo: 'o/r', sha: SHA, tree: TREE, tagName: 'v1', gh: fakeGh({ [`repos/o/r/commits/${SHA}/check-runs`]: 'CI\tcompleted\tfailure\n' }) })
ok(!proof.ok && /red on the tag commit/.test(proof.detail), 'a red tag commit blocks even if a PR was green')

const prTable = (extra = {}) => ({
  [`repos/o/r/commits/${SHA}/check-runs`]: cancelled,
  [`repos/o/r/commits/${SHA}/pulls`]: `636\t${HEAD_SHA}\t2026-10-05T11:00:00Z\n`,
  [`repos/o/r/commits/${HEAD_SHA}`]: `${TREE}\n`,
  [`repos/o/r/commits/${HEAD_SHA}/check-runs`]: green,
  ...extra,
})
proof = findCiProof({ repo: 'o/r', sha: SHA, tree: TREE, tagName: 'v1', gh: fakeGh(prTable()) })
ok(proof.ok && /PR #636/.test(proof.detail) && /identical tree/.test(proof.detail), 'cancelled push CI + merged PR head with the identical tree and green checks = proof (the rc.28 case)')

proof = findCiProof({ repo: 'o/r', sha: SHA, tree: TREE, tagName: 'v1', gh: fakeGh(prTable({ [`repos/o/r/commits/${HEAD_SHA}`]: `${'d'.repeat(40)}\n` })) })
ok(!proof.ok && /gh workflow run CI --ref v1/.test(proof.detail), 'a PR head with a different tree is not proof of this tree; the remedy names the command')

proof = findCiProof({ repo: 'o/r', sha: SHA, tree: TREE, tagName: 'v1', gh: fakeGh(prTable({ [`repos/o/r/commits/${HEAD_SHA}/check-runs`]: 'CI\tcompleted\tfailure\n' })) })
ok(!proof.ok, 'identical tree but red PR checks is not proof')

proof = findCiProof({ repo: 'o/r', sha: SHA, tree: TREE, tagName: 'v1', gh: fakeGh(prTable({ [`repos/o/r/commits/${SHA}/pulls`]: `636\t${HEAD_SHA}\t\n` })) })
ok(!proof.ok, 'an unmerged PR is not the commit\'s history')

proof = findCiProof({ repo: 'o/r', sha: SHA, tree: TREE, tagName: 'v1', gh: fakeGh(prTable({ [`repos/o/r/commits/${SHA}/check-runs`]: 'CI\tin_progress\t\n' })) })
ok(proof.ok, 'CI still running on the push is fine when the identical PR tree is already green')
proof = findCiProof({ repo: 'o/r', sha: SHA, tree: TREE, tagName: 'v1', gh: fakeGh(prTable({ [`repos/o/r/commits/${SHA}/check-runs`]: 'CI\tin_progress\t\n', [`repos/o/r/commits/${SHA}/pulls`]: '' })) })
ok(!proof.ok && /still running/.test(proof.detail), 'pending with no other proof says wait, not rerun')

assert.throws(() => findCiProof({ repo: 'o/r', sha: SHA, tree: TREE, tagName: 'v1', gh: fakeGh({}) }), /could not read check runs/); checks++

// The npm-publish workflow's jobs ("Release: …") sit on the tag commit while it runs and stay after a failed rehearsal.
// They are not CI: counting them would make a workflow's own preflight wait for itself, and one red rehearsal block every later release.
proof = findCiProof({ repo: 'o/r', sha: SHA, tree: TREE, tagName: 'v1', gh: fakeGh({ [`repos/o/r/commits/${SHA}/check-runs`]: `${green}Release: gate\tin_progress\t\n` }) })
ok(proof.ok, 'the workflow\'s own running job does not make the proof pending')
proof = findCiProof({ repo: 'o/r', sha: SHA, tree: TREE, tagName: 'v1', gh: fakeGh({ [`repos/o/r/commits/${SHA}/check-runs`]: `${green}Release: publish\tcompleted\tfailure\n` }) })
ok(proof.ok, 'a failed rehearsal job is not a red CI')
proof = findCiProof({ repo: 'o/r', sha: SHA, tree: TREE, tagName: 'v1', gh: fakeGh({ [`repos/o/r/commits/${SHA}/check-runs`]: 'Release: gate\tin_progress\t\n', [`repos/o/r/commits/${SHA}/pulls`]: '' }) })
ok(!proof.ok && /gh workflow run CI --ref v1/.test(proof.detail), 'release jobs alone are no proof; the remedy is CI on the tag')
proof = findCiProof({ repo: 'o/r', sha: SHA, tree: TREE, tagName: 'v1', gh: fakeGh({ [`repos/o/r/commits/${SHA}/check-runs`]: `${green}Release-notes lint\tcompleted\tfailure\n` }) })
ok(!proof.ok && /Release-notes lint/.test(proof.detail), 'only the exact "Release: " prefix is skipped: a real check that merely starts with "Release" still counts')

// ---- full preflight on real temporary git repositories ----
const base = mkdtempSync(join(tmpdir(), 'gotry-preflight-'))
const sh = (cwd, ...args) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' } })
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`)
  return r.stdout.trim()
}

function makeRepo(name, version = '0.2.0-rc.9') {
  const origin = join(base, `${name}-origin.git`)
  const work = join(base, `${name}-work`)
  sh(base, 'init', '-q', '--bare', '-b', 'main', origin)
  mkdirSync(join(work, 'docs'), { recursive: true })
  sh(work, 'init', '-q', '-b', 'main')
  sh(work, 'remote', 'add', 'origin', origin)
  writeFileSync(join(work, 'package.json'), JSON.stringify({ name: '@scope/pkg', version }))
  writeFileSync(join(work, 'CHANGELOG.md'), `# Changelog\n\n## [${version}] - 2026-10-05\n\n- thing\n`)
  writeFileSync(join(work, 'docs/release-notes.md'), `# Notes\n\n## v${version} · 2026-10-05\n\nwhy\n`)
  writeFileSync(join(work, 'docs/release-notes.zh-CN.md'), `# 说明\n\n## v${version} · 2026-10-05\n\n为什么\n`)
  sh(work, 'add', '.')
  sh(work, 'commit', '-q', '-m', 'release')
  sh(work, 'push', '-q', 'origin', 'main')
  return { origin, work, commit: sh(work, 'rev-parse', 'HEAD'), tree: sh(work, 'rev-parse', 'HEAD^{tree}') }
}

const quiet = () => {}
const noRegistry = async () => null
const names = (r) => r.checks.filter((c) => !c.ok).map((c) => c.name)
const baseOpts = (extra = {}) => ({ ...parseArgs(['--tag', 'latest']), repo: 'o/r', ...extra })
const greenGh = (repoSha) => fakeGh({ [`repos/o/r/commits/${repoSha}/check-runs`]: green })

// happy path: annotated tag pushed, HEAD is the tag, CI green, nothing on the registry yet
{
  const r = makeRepo('happy')
  sh(r.work, 'tag', '-a', 'v0.2.0-rc.9', '-m', 'rc.9')
  sh(r.work, 'push', '-q', 'origin', 'v0.2.0-rc.9')
  const result = await runPreflight(baseOpts(), { root: r.work, gh: greenGh(r.commit), fetchPackument: noRegistry, log: quiet })
  eq(names(result), [], 'every check passes')
  ok(result.ok && result.commit === r.commit && result.tagName === 'v0.2.0-rc.9', 'result names the tag and commit')
}

// lightweight tag works as well as an annotated one
{
  const r = makeRepo('light')
  sh(r.work, 'tag', 'v0.2.0-rc.9')
  sh(r.work, 'push', '-q', 'origin', 'v0.2.0-rc.9')
  const result = await runPreflight(baseOpts(), { root: r.work, gh: greenGh(r.commit), fetchPackument: noRegistry, log: quiet })
  eq(names(result), [], 'a lightweight tag passes too')
}

// no tag at all
{
  const r = makeRepo('notag')
  const result = await runPreflight(baseOpts(), { root: r.work, gh: greenGh(r.commit), fetchPackument: noRegistry, log: quiet })
  ok(names(result).includes('tag') && !result.ok, 'a missing tag fails')
  ok(result.checks.find((c) => c.name === 'tag').detail.includes('git tag -a v0.2.0-rc.9'), 'and says how to create it')
}

// tag exists locally but was never pushed (npm would publish, then gh release create --verify-tag would fail)
{
  const r = makeRepo('unpushed')
  sh(r.work, 'tag', '-a', 'v0.2.0-rc.9', '-m', 'rc.9')
  const result = await runPreflight(baseOpts(), { root: r.work, gh: greenGh(r.commit), fetchPackument: noRegistry, log: quiet })
  eq(names(result), ['tag on remote'], 'only the unpushed tag fails')
  ok(result.checks.find((c) => c.name === 'tag on remote').detail.includes('git push origin v0.2.0-rc.9'))
}

// HEAD moved past the tag: the tarball would not come from the tagged files
{
  const r = makeRepo('drift')
  sh(r.work, 'tag', '-a', 'v0.2.0-rc.9', '-m', 'rc.9')
  sh(r.work, 'push', '-q', 'origin', 'v0.2.0-rc.9')
  writeFileSync(join(r.work, 'later.txt'), 'x')
  sh(r.work, 'add', '.')
  sh(r.work, 'commit', '-q', '-m', 'later')
  sh(r.work, 'push', '-q', 'origin', 'main')
  const result = await runPreflight(baseOpts(), { root: r.work, gh: greenGh(r.commit), fetchPackument: noRegistry, log: quiet })
  eq(names(result), ['HEAD is the tag'], 'HEAD drift is caught, the tag itself is still fine')
  ok(result.checks.find((c) => c.name === 'HEAD is the tag').detail.includes('git switch --detach v0.2.0-rc.9'))
}

// tag on a commit that never reached the default branch
{
  const r = makeRepo('offmain')
  sh(r.work, 'switch', '-q', '-c', 'scratch')
  writeFileSync(join(r.work, 'scratch.txt'), 'x')
  sh(r.work, 'add', '.')
  sh(r.work, 'commit', '-q', '-m', 'scratch')
  sh(r.work, 'tag', '-a', 'v0.2.0-rc.9', '-m', 'rc.9')
  sh(r.work, 'push', '-q', 'origin', 'v0.2.0-rc.9')
  const sha = sh(r.work, 'rev-parse', 'HEAD')
  const result = await runPreflight(baseOpts(), { root: r.work, gh: greenGh(sha), fetchPackument: noRegistry, log: quiet })
  eq(names(result), ['on origin/main'], 'an unmerged commit is not releasable')
}

// dirty tracked tree
{
  const r = makeRepo('dirty')
  sh(r.work, 'tag', '-a', 'v0.2.0-rc.9', '-m', 'rc.9')
  sh(r.work, 'push', '-q', 'origin', 'v0.2.0-rc.9')
  writeFileSync(join(r.work, 'package.json'), JSON.stringify({ name: '@scope/pkg', version: '0.2.0-rc.9', extra: true }))
  const result = await runPreflight(baseOpts(), { root: r.work, gh: greenGh(r.commit), fetchPackument: noRegistry, log: quiet })
  eq(names(result), ['clean tree'])
}

// release docs missing a section, and "## v0.2.0" is not satisfied by "## v0.2.0-rc.9"
{
  const r = makeRepo('docs', '0.2.0')
  writeFileSync(join(r.work, 'docs/release-notes.md'), '# Notes\n\n## v0.2.0-rc.9 · 2026-10-05\n\nwhy\n')
  sh(r.work, 'add', '.')
  sh(r.work, 'commit', '-q', '-m', 'notes')
  sh(r.work, 'push', '-q', 'origin', 'main')
  const sha = sh(r.work, 'rev-parse', 'HEAD')
  sh(r.work, 'tag', '-a', 'v0.2.0', '-m', '0.2.0')
  sh(r.work, 'push', '-q', 'origin', 'v0.2.0')
  const result = await runPreflight(baseOpts(), { root: r.work, gh: greenGh(sha), fetchPackument: noRegistry, log: quiet })
  eq(names(result), ['release docs'])
  const detail = result.checks.find((c) => c.name === 'release docs').detail
  ok(detail.includes('docs/release-notes.md') && !detail.includes('CHANGELOG') && !detail.includes('zh-CN'), 'only the file that lacks the exact heading is named')
}

// CI proof: skipped with a reason, missing, and via the PR head when push CI was cancelled
{
  const r = makeRepo('ci')
  sh(r.work, 'tag', '-a', 'v0.2.0-rc.9', '-m', 'rc.9')
  sh(r.work, 'push', '-q', 'origin', 'v0.2.0-rc.9')
  const logs = []
  let result = await runPreflight(baseOpts({ skipCiProof: 'gh is offline' }), { root: r.work, gh: fakeGh({}), fetchPackument: noRegistry, log: (l) => logs.push(l) })
  ok(result.ok && logs.some((l) => l.includes('CI proof — skipped: gh is offline')), 'a skip is explicit and leaves its reason in the output')
  result = await runPreflight(baseOpts(), { root: r.work, gh: fakeGh({}), fetchPackument: noRegistry, log: quiet })
  ok(names(result).includes('CI proof'), 'unreadable CI state fails closed')
  const sha = r.commit
  const table = {
    [`repos/o/r/commits/${sha}/check-runs`]: cancelled,
    [`repos/o/r/commits/${sha}/pulls`]: `7\t${HEAD_SHA}\t2026-10-05T11:00:00Z\n`,
    [`repos/o/r/commits/${HEAD_SHA}`]: `${r.tree}\n`,
    [`repos/o/r/commits/${HEAD_SHA}/check-runs`]: green,
  }
  result = await runPreflight(baseOpts(), { root: r.work, gh: fakeGh(table), fetchPackument: noRegistry, log: quiet })
  eq(names(result), [], 'the rc.28 situation passes through the PR head with the identical tree')
}

// registry: already published; dist-tag ahead; allowed downgrade; unreachable
{
  const r = makeRepo('registry')
  sh(r.work, 'tag', '-a', 'v0.2.0-rc.9', '-m', 'rc.9')
  sh(r.work, 'push', '-q', 'origin', 'v0.2.0-rc.9')
  const deps = (pk) => ({ root: r.work, gh: greenGh(r.commit), fetchPackument: async () => pk, log: quiet })
  let result = await runPreflight(baseOpts(), deps({ versions: { '0.2.0-rc.9': {} }, 'dist-tags': { latest: '0.2.0-rc.9' } }))
  ok(names(result).includes('registry') && /already published/.test(result.checks.find((c) => c.name === 'registry').detail), 'a published version is refused up front')
  result = await runPreflight(baseOpts(), deps({ versions: {}, 'dist-tags': { latest: '0.2.0-rc.10' } }))
  ok(names(result).includes('registry') && /not older than/.test(result.checks.find((c) => c.name === 'registry').detail), 'publishing below the dist-tag is refused')
  result = await runPreflight(baseOpts({ allowDowngrade: true }), deps({ versions: {}, 'dist-tags': { latest: '0.2.0-rc.10' } }))
  ok(result.ok, '--allow-downgrade is an explicit override')
  result = await runPreflight(baseOpts(), deps({ versions: {}, 'dist-tags': { latest: '0.2.0-rc.8' } }))
  ok(result.ok, 'moving the dist-tag forward passes')
  result = await runPreflight(baseOpts({ tag: 'rc' }), deps({ versions: {}, 'dist-tags': { latest: '0.2.0-rc.8' } }))
  ok(result.ok, 'a dist-tag the package does not have yet passes')
  result = await runPreflight(baseOpts(), { root: r.work, gh: greenGh(r.commit), fetchPackument: async () => { throw new Error('registry answered 503') }, log: quiet })
  ok(names(result).includes('registry'), 'an unreachable registry fails closed')
}

// ---- writeExpected: what npm pack says becomes the contract for the pull-back ----
{
  const r = makeRepo('expected')
  const fakeRun = (cmd, args) => {
    eq([cmd, ...args], ['npm', 'pack', '--dry-run', '--json'], 'it asks npm what the tarball will be')
    return { status: 0, stdout: JSON.stringify([{ name: '@scope/pkg', version: '0.2.0-rc.9', shasum: 'f'.repeat(40), integrity: 'sha512-abc', entryCount: 543, unpackedSize: 8936680 }]), stderr: '' }
  }
  const e = writeExpected({ root: r.work, tag: 'latest', run: fakeRun, now: () => new Date('2026-10-05T00:00:00Z') })
  const onDisk = JSON.parse(readFileSync(join(r.work, '.release-expected.json'), 'utf8'))
  eq(onDisk, e, 'what is returned is what is on disk')
  eq([e.name, e.version, e.tag, e.shasum, e.integrity, e.fileCount, e.unpackedSize], ['@scope/pkg', '0.2.0-rc.9', 'latest', 'f'.repeat(40), 'sha512-abc', 543, 8936680])
  eq([e.commit, e.tree], [r.commit, r.tree], 'bound to the commit and tree it was built from')
  assert.throws(() => writeExpected({ root: r.work, tag: 'latest', run: () => ({ status: 0, stdout: JSON.stringify([{ name: '@scope/pkg', version: '9.9.9' }]), stderr: '' }) }), /package\.json is 0\.2\.0-rc\.9/); checks++
  assert.throws(() => writeExpected({ root: r.work, tag: 'latest', run: () => ({ status: 1, stdout: '', stderr: 'boom' }) }), /npm pack --dry-run failed/); checks++
}

// writeExpected with a pack directory: the pack is real, the tarball name is recorded, the directory is created
{
  const r = makeRepo('packdir')
  const packDir = join(base, 'bundle', 'nested')
  const fakeRun = (cmd, args) => {
    eq([cmd, ...args], ['npm', 'pack', '--json', '--pack-destination', packDir], 'a real pack into the directory')
    return { status: 0, stdout: JSON.stringify([{ name: '@scope/pkg', version: '0.2.0-rc.9', filename: 'scope-pkg-0.2.0-rc.9.tgz', shasum: 'e'.repeat(40), integrity: 'sha512-xyz', entryCount: 5, unpackedSize: 99 }]), stderr: '' }
  }
  const e = writeExpected({ root: r.work, tag: 'latest', packDir, run: fakeRun, now: () => new Date('2026-10-06T00:00:00Z') })
  eq(e.tarball, 'scope-pkg-0.2.0-rc.9.tgz', 'the record names the tarball the workflow will publish')
  ok(readFileSync(join(r.work, '.release-expected.json'), 'utf8').includes('"tarball"'), 'and the name reaches the file')
  eq(spawnSync('test', ['-d', packDir]).status, 0, 'the pack directory is created when missing')
  assert.throws(() => writeExpected({ root: r.work, tag: 'latest', packDir, run: () => ({ status: 0, stdout: JSON.stringify([{ name: '@scope/pkg', version: '0.2.0-rc.9' }]), stderr: '' }) }), /did not say which tarball/); checks++
  assert.throws(() => writeExpected({ root: r.work, tag: 'latest', packDir, run: () => ({ status: 1, stdout: '', stderr: 'boom' }) }), /npm pack failed: boom/); checks++
}

// the CLI runs when reached through a symlinked directory (see release-lib isMain); no --tag is a usage error, exit 2
{
  const link = join(base, 'scripts-link')
  symlinkSync(dirname(fileURLToPath(import.meta.url)), link)
  const r = spawnSync(process.execPath, [join(link, 'release-preflight.mjs')], { encoding: 'utf8' })
  eq(r.status, 2, 'usage error exits 2')
  ok(r.stderr.includes('--tag is required'), `the script really ran when reached through a symlink\n${r.stderr}`)
}

rmSync(base, { recursive: true, force: true })
console.log(`RELEASE PREFLIGHT TESTS: ${checks} checks OK`)
