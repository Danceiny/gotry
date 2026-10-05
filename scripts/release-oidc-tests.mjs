#!/usr/bin/env node
/**
 * Tests for scripts/release-oidc.mjs, the OIDC-side steps of .github/workflows/npm-publish.yml.
 *
 * GitHub, npm and the registry are all injected, so the suite is offline. The cases are the ways the zero-click path
 * can fail that npm itself reports badly: it swallows every OIDC failure and ends in "not logged in", so the script
 * has to read the verdict out of the verbose log; and a job log of a public repository must never hold a token.
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { NPM_AUDIENCE, classifyPublish, decodeClaims, fetchIdToken, judgeClaims, parseArgs, renderClaims, runClaims, runPublish, trustedPublisherSettings } from './release-oidc.mjs'

let checks = 0
const ok = (cond, msg) => { assert.ok(cond, msg); checks++ }
const eq = (a, b, msg = `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`) => { assert.deepEqual(a, b, msg); checks++ }

const CLAIMS = {
  iss: 'https://token.actions.githubusercontent.com',
  aud: NPM_AUDIENCE,
  sub: 'repo:Danceiny/gotry:environment:npm-publish',
  jti: 'JTI-MUST-NOT-BE-PRINTED',
  actor: 'ACTOR-MUST-NOT-BE-PRINTED',
  repository: 'Danceiny/gotry',
  repository_owner: 'Danceiny',
  repository_visibility: 'public',
  job_workflow_ref: 'Danceiny/gotry/.github/workflows/npm-publish.yml@refs/tags/v0.2.0-rc.29',
  workflow_ref: 'Danceiny/gotry/.github/workflows/npm-publish.yml@refs/tags/v0.2.0-rc.29',
  environment: 'npm-publish',
  ref: 'refs/tags/v0.2.0-rc.29',
  ref_type: 'tag',
  sha: 'a'.repeat(40),
  event_name: 'workflow_dispatch',
  runner_environment: 'github-hosted',
  run_id: '123456',
  run_attempt: '1',
}
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url')
const jwtOf = (claims) => `eyJhbGciOiJSUzI1NiJ9.${b64(claims)}.c2lnbmF0dXJlLWJ5dGVzLWFyZS1sb25nLWVub3VnaA`

// ---- claims decoding ----
eq(decodeClaims(jwtOf(CLAIMS)), CLAIMS, 'the payload round-trips')
assert.throws(() => decodeClaims('not-a-jwt'), /not a JWT/); checks++
assert.throws(() => decodeClaims('a.!!!.c'), /not JSON/); checks++

// ---- fetching the id-token the way npm does ----
const ENV = { ACTIONS_ID_TOKEN_REQUEST_URL: 'https://pipelines.example/idtoken?api-version=2.0', ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'runtime-bearer' }
await assert.rejects(fetchIdToken({ env: {} }), /id-token: write/); checks++
{
  let seen
  const token = await fetchIdToken({ env: ENV, fetchImpl: async (url, init) => { seen = { url: String(url), headers: init.headers }; return { ok: true, status: 200, json: async () => ({ value: 'the-id-token' }) } } })
  eq(token, 'the-id-token')
  ok(seen.url.includes('api-version=2.0') && seen.url.includes('audience=npm%3Aregistry.npmjs.org'), `the audience npm expects is appended to GitHub's own query: ${seen.url}`)
  eq(seen.headers.authorization, 'Bearer runtime-bearer', 'authenticated with the runtime bearer, as npm does')
}
await assert.rejects(fetchIdToken({ env: ENV, fetchImpl: async () => ({ ok: false, status: 403, json: async () => ({}) }) }), /answered 403/); checks++
await assert.rejects(fetchIdToken({ env: ENV, fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({}) }) }), /without a token/); checks++

// ---- the values for the npmjs.com form come from the claims, not from memory ----
eq(trustedPublisherSettings(CLAIMS), { owner: 'Danceiny', repository: 'gotry', workflow: 'npm-publish.yml', environment: 'npm-publish' })
eq(trustedPublisherSettings({ ...CLAIMS, environment: undefined }).environment, '', 'no environment in the run, none to enter')
eq(trustedPublisherSettings({ repository: 'o/r', repository_owner: 'o' }).workflow, '', 'no workflow ref, no workflow file')

// ---- what makes a job unable to be a trusted publisher at all ----
eq(judgeClaims(CLAIMS), [], 'a hosted runner on a tag is fine')
ok(judgeClaims({ ...CLAIMS, runner_environment: 'self-hosted' }).some((p) => /GitHub-hosted runners only/.test(p)), 'self-hosted runners are refused by npm')
ok(judgeClaims({ ...CLAIMS, ref_type: 'branch', ref: 'refs/heads/main' }).some((p) => /version tag/.test(p)), 'a branch dispatch is not a release')
eq(judgeClaims({ ...CLAIMS, ref_type: 'branch' }, { requireTag: false }), [], 'unless the caller says tags are not required')
ok(judgeClaims({ ...CLAIMS, job_workflow_ref: '', workflow_ref: '' }).some((p) => /no workflow file/.test(p)))

// ---- rendering shows the matching claims and never the rest ----
{
  const text = renderClaims(CLAIMS).join('\n')
  ok(text.includes('Danceiny/gotry') && text.includes('npm-publish.yml') && text.includes('npm-publish'), 'repository, workflow file and environment are shown')
  ok(/Organization or user\s+Danceiny/.test(text) && /Repository\s+gotry/.test(text) && /Workflow filename\s+npm-publish\.yml/.test(text), 'the form values are spelled out')
  ok(text.includes('tick "npm publish"'), 'the allowed-actions requirement is stated: stage publish alone does not publish')
  ok(!text.includes('JTI-MUST-NOT-BE-PRINTED') && !text.includes('ACTOR-MUST-NOT-BE-PRINTED') && !text.includes('sub '), 'claims that npm does not match on stay out of the log')
  ok(text.includes('will be generated (public repository)'), 'public repository → provenance')
  ok(renderClaims({ ...CLAIMS, repository_visibility: 'private' }).join('\n').includes('not generated (repository is private)'), 'private repository → no provenance')
}

// ---- the claims step end to end: the token is never printed ----
{
  const lines = []
  const token = jwtOf(CLAIMS)
  const code = await runClaims({ env: ENV, fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ value: token }) }), log: (l) => lines.push(l) })
  eq(code, 0)
  ok(!lines.join('\n').includes(token) && !lines.join('\n').includes('eyJ'), 'the raw id-token and its encoded payload never reach the log')
  const bad = []
  eq(await runClaims({ env: {}, log: (l) => bad.push(l) }), 1, 'no id-token permission fails the job')
  ok(bad.some((l) => l.startsWith('::error::') && /id-token: write/.test(l)), 'with the reason, as an annotation')
  const branch = []
  eq(await runClaims({ env: ENV, fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ value: jwtOf({ ...CLAIMS, ref_type: 'branch', ref: 'refs/heads/main' }) }) }), log: (l) => branch.push(l) }), 1, 'a branch dispatch fails after printing what it saw')
  ok(branch.some((l) => /Workflow filename/.test(l)) && branch.some((l) => /version tag/.test(l)))
}

// ---- reading npm's verdict out of its verbose log ----
const EXCHANGED = 'npm http fetch POST 200 https://registry.npmjs.org/-/npm/v1/oidc/token/exchange/package/@danceiny%2fgotry 301ms\nnpm verbose oidc Successfully retrieved and set token\nnpm verbose oidc Enabling provenance\n'
{
  const v = classifyPublish({ status: 0, output: `${EXCHANGED}npm notice Publishing to https://registry.npmjs.org/ with tag latest and public access (dry-run)\n+ @danceiny/gotry@0.2.0-rc.29`, dryRun: true })
  ok(v.ok && v.exchanged && !v.published && v.hints.length === 0, 'a rehearsal that exchanged is OK, published nothing, and has nothing to say')
}
{
  const out = 'npm verbose oidc Failed token exchange request with body message: no matching trusted publisher for Danceiny/gotry\nnpm warn publish This command requires you to be logged in to https://registry.npmjs.org/ (dry-run)\n'
  const v = classifyPublish({ status: 0, output: out, dryRun: true })
  ok(!v.ok && !v.exchanged, 'npm exits 0 on a dry run whose exchange failed; that is not a proof')
  eq(v.failures, ['Failed token exchange request with body message: no matching trusted publisher for Danceiny/gotry'], 'the registry\'s own reason is carried')
  ok(/Trusted Publisher form/.test(v.hints[0]) && /case-sensitive/.test(v.hints[0]), 'and the hint points at the form')
}
{
  const v = classifyPublish({ status: 0, output: 'npm warn publish This command requires you to be logged in (dry-run)\n', dryRun: true })
  ok(!v.ok && /never attempted/.test(v.hints[0]) && /id-token: write/.test(v.hints[0]), 'no oidc line at all means the exchange was never tried')
}
{
  const v = classifyPublish({ status: 0, output: `${EXCHANGED}+ @danceiny/gotry@0.2.0-rc.29`, dryRun: false })
  ok(v.ok && v.published && v.exchanged, 'a real publish that exchanged and exited 0 is published as far as npm is concerned')
}
{
  const v = classifyPublish({ status: 1, output: `${EXCHANGED}npm error code E403\nnpm error 403 403 Forbidden - PUT https://registry.npmjs.org/@danceiny%2fgotry`, dryRun: false })
  ok(!v.ok && v.hints.some((h) => /tick "npm publish"/.test(h)), 'exchanged but refused → the allowed-actions hint')
  ok(!v.hints.some((h) => /provenance/i.test(h)), 'an unrelated failure does not blame provenance just because npm said "Enabling provenance"')
}
{
  const v = classifyPublish({ status: 1, output: `${EXCHANGED}npm error code E403\nnpm error You cannot publish over the previously published versions: 0.2.0-rc.29.`, dryRun: false })
  ok(v.hints.some((h) => /already on the registry/.test(h) && /verify-published/.test(h)), 'a republish attempt is told to pull back, not to retry')
}
{
  const v = classifyPublish({ status: 1, output: `${EXCHANGED}npm error code E422\nnpm error Error verifying sigstore provenance bundle: Failed to validate repository information`, dryRun: false })
  ok(v.hints.some((h) => /repository\.url/.test(h)), 'a provenance rejection names the field that has to match')
}
{
  const v = classifyPublish({ status: 0, output: '+ @danceiny/gotry@0.2.0-rc.29', dryRun: false })
  ok(v.ok && !v.exchanged, 'published with some other credential: ok, but visibly not through OIDC')
}

// ---- running npm ----
{
  const lines = []
  const calls = []
  const dir = mkdtempSync(join(tmpdir(), 'gotry-oidc-'))
  const summary = join(dir, 'summary.md')
  const run = (cmd, args) => { calls.push([cmd, ...args]); return { status: 0, stdout: '', stderr: `${EXCHANGED}npm notice (dry-run)` } }
  eq(runPublish({ tarball: 'bundle/danceiny-gotry-0.2.0-rc.29.tgz', tag: 'latest', dryRun: true, run, log: (l) => lines.push(l), summaryFile: summary }), 0)
  eq(calls, [['npm', 'publish', 'bundle/danceiny-gotry-0.2.0-rc.29.tgz', '--tag', 'latest', '--access', 'public', '--loglevel', 'verbose', '--dry-run']], 'the exact command: the tarball, an explicit tag, public access, verbose so the exchange verdict exists')
  ok(lines.some((l) => l.startsWith('REHEARSAL OK')), 'the rehearsal says what it proved')
  ok(/rehearsal\) — OK/.test(readFileSync(summary, 'utf8')) && /worked/.test(readFileSync(summary, 'utf8')), 'and writes a step summary')

  calls.length = 0
  lines.length = 0
  eq(runPublish({ tarball: 't.tgz', tag: 'rc', registry: 'https://registry.npmjs.org/', run, log: (l) => lines.push(l), summaryFile: '' }), 0)
  eq(calls[0].slice(-2), ['--registry', 'https://registry.npmjs.org/'], 'no --dry-run on a real publish; the registry is explicit when given')
  ok(!calls[0].includes('--dry-run') && lines.some((l) => l.startsWith('PUBLISHED through npm')) && lines.some((l) => /not "published" yet/.test(l)), 'a real publish never claims "published": the pull-back does')

  // a token-shaped string in npm's output withholds the whole output
  lines.length = 0
  const leaky = `${'npm_'}${'Ab1Cd2'.repeat(7)}`
  eq(runPublish({ tarball: 't.tgz', tag: 'latest', dryRun: true, run: () => ({ status: 0, stdout: '', stderr: `${EXCHANGED}leak ${leaky}` }), log: (l) => lines.push(l), summaryFile: '' }), 1)
  ok(lines.length === 1 && /withheld/.test(lines[0]) && !lines.join('\n').includes(leaky), 'the output is withheld, not printed with the secret in it')

  // npm failing is failure with the hints, and a missing exit code counts as failure
  lines.length = 0
  eq(runPublish({ tarball: 't.tgz', tag: 'latest', run: () => ({ status: null, stdout: '', stderr: 'killed' }), log: (l) => lines.push(l), summaryFile: '' }), 1)
  ok(lines.some((l) => /npm publish failed \(exit none\)/.test(l)))
  rmSync(dir, { recursive: true, force: true })
}

// ---- argument parsing ----
eq(parseArgs(['claims']).command, 'claims')
eq(parseArgs(['publish', '--tarball', 'a.tgz', '--tag', 'latest', '--dry-run']), { command: 'publish', audience: NPM_AUDIENCE, tarball: 'a.tgz', tag: 'latest', dryRun: true, registry: '' })
for (const [argv, re] of [
  [[], /first argument/],
  [['deploy'], /first argument/],
  [['publish', '--tag', 'latest'], /--tarball is required/],
  [['publish', '--tarball', 'a.tgz'], /--tag is required/],
  [['publish', '--tarball', 'a.tgz', '--tag', '--dry-run'], /needs a value/],
  [['publish', '--tarball', 'a.tgz', '--tag', 'v1.2.3 || rm'], /plain dist-tag/],
  [['claims', '--nope'], /unknown argument/],
]) {
  assert.throws(() => parseArgs(argv), re, `${argv.join(' ')} is refused`)
  checks++
}

// ---- the CLI itself, reached through a symlinked directory (see release-lib isMain) ----
{
  const here = dirname(fileURLToPath(import.meta.url))
  const cli = (...args) => spawnSync(process.execPath, [join(here, 'release-oidc.mjs'), ...args], { encoding: 'utf8', env: { PATH: process.env.PATH } })
  let r = cli()
  eq(r.status, 2, 'no subcommand is a usage error')
  ok(r.stderr.includes('usage: node release-oidc.mjs'), 'with the usage')
  r = cli('publish', '--tarball', join(tmpdir(), 'definitely-missing.tgz'), '--tag', 'latest')
  eq(r.status, 2, 'a missing tarball is an environment error, before npm is ever run')
  r = cli('claims')
  eq(r.status, 1, 'claims outside Actions fails')
  ok(r.stdout.includes('::error::') && /id-token: write/.test(r.stdout), `and says why (${r.stdout.trim()})`)
}

console.log(`RELEASE OIDC TESTS: ${checks} checks OK`)
