#!/usr/bin/env node
/**
 * scripts/verify-published.mjs — the release pull-back, in one command.
 *
 * AGENTS.md release discipline: after publishing, pull the version back from the registry; until this passes,
 * no authority may say "published" (the rc.16 lesson: the tag was pushed and docs claimed published, but the
 * registry had no such version). The pull-back used to be a hand-typed recipe; this script is that recipe.
 *
 * What it checks, in order:
 *   registry   the version is visible (polls while npm finishes processing), the dist-tag points at it, and the
 *              tarball facts equal what scripts/publish-npm.sh recorded before publishing (reproducible build)
 *   tarball    the downloaded bytes hash to the registry's shasum and integrity
 *   clean room (fresh HOME and npm cache, official registry only, no LLM key, empty cwd) —
 *     doctor        prints its report, no stack trace, nothing from --doctor-absent matches
 *     plugin        the installed dist entry imports and exposes the gotry-tools plugin (a web 200 does not
 *                   prove plugin loading; this catches a missing runtime dependency or a .ts under node_modules)
 *     web           boots, a token URL answers 303 → 200 with a cookie, a tokenless request is 401
 *     one-shot      a headless run without credentials fails with MISSING_CREDENTIAL and no stack trace
 *
 * Usage:
 *   node scripts/verify-published.mjs [<version>] [--tag latest] [--expected .release-expected.json]
 *        [--wait 600] [--poll 10] [--registry <url>] [--registry-only] [--doctor-absent <regex>]...
 *        [--json <file>] [--keep]
 *
 * With no arguments it reads ./.release-expected.json, which publish-npm.sh writes before the publish click.
 * A full pass writes ./.release-verified.json (the receipt scripts/post-release-docs.mjs reads); --registry-only
 * never writes it, because a registry-only pass is not the pull-back.
 * Exit: 0 every check passed; 1 a check failed; 2 usage or environment error.
 */
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { EXPECTED_FILE, OFFICIAL_REGISTRY, UsageError, VERIFIED_FILE, fetchPackument, isMain, redact } from './release-lib.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
export const PLUGIN_NAME = 'gotry-tools'
export const DEFAULT_PROMPT = 'Two recovery days from Shenzhen, budget 3000'

export function parseArgs(argv) {
  const opts = {
    version: '', tag: '', expected: '', wait: 600, poll: 10, registry: OFFICIAL_REGISTRY, registryOnly: false,
    doctorAbsent: [], json: '', keep: false,
  }
  const positional = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const value = () => {
      const v = argv[++i]
      if (v === undefined) throw new UsageError(`${a} needs a value`)
      return v
    }
    if (a === '--tag') opts.tag = value()
    else if (a === '--expected') opts.expected = value()
    else if (a === '--wait') opts.wait = Number(value())
    else if (a === '--poll') opts.poll = Number(value())
    else if (a === '--registry') opts.registry = value()
    else if (a === '--registry-only') opts.registryOnly = true
    else if (a === '--doctor-absent') opts.doctorAbsent.push(value())
    else if (a === '--json') opts.json = value()
    else if (a === '--keep') opts.keep = true
    else if (a === '-h' || a === '--help') throw new UsageError('')
    else if (a.startsWith('--')) throw new UsageError(`unknown flag ${a}`)
    else positional.push(a)
  }
  if (positional.length > 1) throw new UsageError(`expected at most one version, got: ${positional.join(' ')}`)
  opts.version = positional[0] ?? ''
  if (!Number.isFinite(opts.wait) || opts.wait < 0) throw new UsageError('--wait must be a non-negative number of seconds')
  if (!Number.isFinite(opts.poll) || opts.poll <= 0) throw new UsageError('--poll must be a positive number of seconds')
  if (!opts.registry.endsWith('/')) opts.registry += '/'
  return opts
}

/** A Node stack frame such as "    at foo (/path/file.js:12:3)" means an uncaught error leaked to the user. */
export function hasStackTrace(text) {
  return /^\s+at .+[(/].*:\d+:\d+\)?\s*$/m.test(text)
}

/** Compare what the registry serves with what the publisher recorded before publishing. */
export function compareExpected(dist, expected) {
  const problems = []
  if (!expected) return problems
  if (expected.shasum && dist.shasum !== expected.shasum) problems.push(`shasum ${dist.shasum} ≠ expected ${expected.shasum}`)
  if (expected.integrity && dist.integrity !== expected.integrity) problems.push('integrity differs from the pre-publish build')
  if (expected.fileCount != null && dist.fileCount != null && dist.fileCount !== expected.fileCount) {
    problems.push(`fileCount ${dist.fileCount} ≠ expected ${expected.fileCount}`)
  }
  if (expected.unpackedSize != null && dist.unpackedSize != null && dist.unpackedSize !== expected.unpackedSize) {
    problems.push(`unpackedSize ${dist.unpackedSize} ≠ expected ${expected.unpackedSize}`)
  }
  return problems
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function waitFor(probe, timeoutMs, stepMs, abort = () => false) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const got = await probe()
    if (got) return got
    if (abort() || Date.now() > deadline) return null
    await sleep(stepMs)
  }
}

function freePort() {
  return new Promise((ok, fail) => {
    const s = createServer()
    s.on('error', fail)
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address()
      s.close(() => ok(port))
    })
  })
}

function killGroup(child) {
  if (!child || child.exitCode !== null) return
  try { process.kill(-child.pid, 'SIGTERM') } catch { /* already gone */ }
  setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL') } catch { /* already gone */ } }, 5000).unref()
}

/** Fresh HOME and npm cache, official registry only, no LLM key, nothing inherited from the caller's shell. */
export function cleanRoomEnv(root, registry = OFFICIAL_REGISTRY) {
  const home = join(root, 'home')
  mkdirSync(home, { recursive: true })
  return {
    HOME: home,
    PATH: [dirname(process.execPath), '/usr/bin', '/bin'].join(':'),
    LANG: process.env.LANG ?? 'en_US.UTF-8',
    NO_COLOR: '1',
    npm_config_cache: join(root, 'cache'),
    npm_config_userconfig: '/dev/null',
    npm_config_registry: registry,
    npm_config_update_notifier: 'false',
  }
}

function findInstalledPackage(cacheDir, name, version) {
  const npx = join(cacheDir, '_npx')
  if (!existsSync(npx)) return ''
  for (const hash of readdirSync(npx)) {
    const dir = join(npx, hash, 'node_modules', ...name.split('/'))
    try {
      if (JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).version === version) return dir
    } catch { /* not this one */ }
  }
  return ''
}

const results = []
function record(name, ok, detail) {
  results.push({ name, ok, detail })
  console.log(`${ok ? '✅' : '❌'} ${name} — ${detail}`)
  return ok
}

function tail(text, n = 12) {
  return redact(text).trimEnd().split('\n').slice(-n).join('\n')
}

async function checkRegistry(opts, name, version, tag, expected) {
  const t0 = Date.now()
  let tags = {}
  let polling = false
  const seen = await waitFor(async () => {
    let found = null
    try {
      const pk = await fetchPackument(opts.registry, name)
      tags = pk?.['dist-tags'] ?? {}
      found = pk?.versions?.[version] ?? null
    } catch (err) {
      process.stdout.write(`(registry: ${err.message}) `)
      polling = true
    }
    if (!found) {
      process.stdout.write('.')
      polling = true
    }
    return found
  }, opts.wait * 1000, opts.poll * 1000)
  if (polling) console.log('')
  if (!seen) {
    record('registry: version visible', false, `${name}@${version} not on ${opts.registry} after ${opts.wait}s — do NOT call it published`)
    return null
  }
  const waited = Math.round((Date.now() - t0) / 1000)
  record('registry: version visible', true, `${name}@${version} (after ${waited}s)`)
  record('registry: dist-tag', tags[tag] === version, `${tag} → ${tags[tag] ?? '(unset)'}${tags[tag] === version ? '' : `, expected ${version}`}`)
  const dist = { ...(seen.dist ?? {}), distTags: tags }
  if (dist.fileCount == null || dist.unpackedSize == null) {
    console.log('   (abbreviated packument lacks fileCount/unpackedSize; compared shasum/integrity only)')
  }
  const problems = compareExpected(dist, expected)
  if (expected) {
    record('registry: matches the pre-publish build', problems.length === 0,
      problems.length ? problems.join('; ') : `shasum ${dist.shasum}${dist.fileCount != null ? `, ${dist.fileCount} files` : ''} — reproducible`)
  } else {
    console.log('➖ registry: matches the pre-publish build — skipped (no expected-build record)')
  }
  return dist
}

async function checkTarball(dist) {
  if (!dist?.tarball) return record('tarball: bytes', false, 'registry gave no tarball URL')
  try {
    const res = await fetch(dist.tarball, { signal: AbortSignal.timeout(120_000) })
    if (!res.ok) return record('tarball: bytes', false, `download answered ${res.status}`)
    const buf = Buffer.from(await res.arrayBuffer())
    const sha1 = createHash('sha1').update(buf).digest('hex')
    const sri = `sha512-${createHash('sha512').update(buf).digest('base64')}`
    const ok = sha1 === dist.shasum && (!dist.integrity || sri === dist.integrity)
    return record('tarball: bytes', ok, ok ? `${buf.length} bytes hash to the registry shasum and integrity` : `sha1 ${sha1} / ${sri.slice(0, 24)}… differ from the registry`)
  } catch (err) {
    return record('tarball: bytes', false, err.message)
  }
}

function runNpx(spec, args, env, cwd, timeoutMs) {
  const r = spawnSync('npx', ['--yes', spec, ...args], { cwd, env, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 64 << 20 })
  return { status: r.status, out: `${r.stdout ?? ''}\n${r.stderr ?? ''}`, timedOut: r.error?.code === 'ETIMEDOUT' }
}

function checkDoctor(spec, env, cwd, doctorAbsent) {
  const r = runNpx(spec, ['doctor'], env, cwd, 600_000)
  const bad = []
  if (r.timedOut) bad.push('timed out')
  if (![0, 1].includes(r.status)) bad.push(`exit ${r.status} (a clean machine exits 0 or 1)`)
  if (!r.out.includes('[gotry-doctor]')) bad.push('no "[gotry-doctor]" report header')
  if (hasStackTrace(r.out)) bad.push('stack trace in output')
  for (const pattern of doctorAbsent) {
    const hit = r.out.split('\n').find((line) => new RegExp(pattern).test(line))
    if (hit) bad.push(`forbidden line present (/${pattern}/): ${redact(hit).trim().slice(0, 120)}`)
  }
  record('clean room: doctor', bad.length === 0, bad.length ? `${bad.join('; ')}\n${tail(r.out)}` : `exit ${r.status}, report printed, no stack trace${doctorAbsent.length ? `, ${doctorAbsent.length} forbidden pattern(s) absent` : ''}`)
}

function checkPlugin(pkgDir, env, cwd) {
  if (!pkgDir) return record('clean room: plugin import', false, 'installed package not found in the npx cache')
  const entry = pathToFileURL(join(pkgDir, 'dist/src/index.js')).href
  const code = `const m = await import(${JSON.stringify(entry)}); console.log(JSON.stringify({ name: m.name, apply: typeof m.apply, inject: m.inject }))`
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { cwd, env, encoding: 'utf8', timeout: 120_000 })
  let got = null
  try { got = JSON.parse(r.stdout.trim().split('\n').pop()) } catch { /* reported below */ }
  const ok = r.status === 0 && got?.name === PLUGIN_NAME && got.apply === 'function' && Array.isArray(got.inject)
  record('clean room: plugin import', ok, ok ? `dist entry loads → ${got.name}, apply(), inject [${got.inject.join(', ')}]` : `import failed\n${tail(`${r.stdout}\n${r.stderr}`)}`)
}

async function checkWeb(spec, env, cwd) {
  const port = await freePort()
  const child = spawn('npx', ['--yes', spec, 'web', '--port', String(port), '--no-open'], { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
  let log = ''
  child.stdout.on('data', (d) => { log += d })
  child.stderr.on('data', (d) => { log += d })
  try {
    const url = await waitFor(() => log.match(/dsh web: (http:\/\/127\.0\.0\.1:\d+\/\?token=[\w-]+)/)?.[1] ?? null, 240_000, 500, () => child.exitCode !== null)
    if (!url) return record('clean room: web', false, `no token URL printed${child.exitCode !== null ? ` (process exited ${child.exitCode})` : ' within 240s'}\n${tail(log)}`)
    const base = `http://127.0.0.1:${port}/`
    const noToken = await fetch(base, { redirect: 'manual' })
    const first = await fetch(url, { redirect: 'manual' })
    const cookie = (first.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ')
    const page = await fetch(new URL(first.headers.get('location') ?? '/', url), { headers: { cookie } })
    const html = (await page.text()).slice(0, 200).toLowerCase()
    const ok = noToken.status === 401 && first.status === 303 && page.status === 200 && html.includes('<!doctype html') && cookie.length > 0
    record('clean room: web', ok, ok ? 'boots; tokenless 401, token URL 303 → 200 with a session cookie' : `tokenless ${noToken.status}, token URL ${first.status}, page ${page.status}, cookie ${cookie ? 'set' : 'missing'}`)
  } catch (err) {
    record('clean room: web', false, err.message)
  } finally {
    killGroup(child)
  }
}

function checkOneShot(spec, env, cwd) {
  const r = runNpx(spec, [DEFAULT_PROMPT], env, cwd, 300_000)
  const bad = []
  if (r.timedOut) bad.push('timed out')
  if (r.status === 0) bad.push('exit 0 (a run without credentials must fail)')
  if (!r.out.includes('MISSING_CREDENTIAL')) bad.push('no MISSING_CREDENTIAL message')
  if (hasStackTrace(r.out)) bad.push('stack trace in output')
  record('clean room: one-shot without credentials', bad.length === 0, bad.length ? `${bad.join('; ')}\n${tail(r.out)}` : `exit ${r.status}, host MISSING_CREDENTIAL message, no stack trace`)
}

async function main() {
  let opts
  try { opts = parseArgs(process.argv.slice(2)) } catch (err) {
    if (err instanceof UsageError) {
      console.error(`${err.message ? `error: ${err.message}\n` : ''}usage: node scripts/verify-published.mjs [<version>] [--tag latest] [--expected ${EXPECTED_FILE}] [--wait 600] [--poll 10] [--registry <url>] [--registry-only] [--doctor-absent <regex>]... [--json <file>] [--keep]`)
      return 2
    }
    throw err
  }
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  const expectedPath = resolve(opts.expected || join(ROOT, EXPECTED_FILE))
  const expected = existsSync(expectedPath) ? JSON.parse(readFileSync(expectedPath, 'utf8')) : null
  // A receipt left by an earlier release must never satisfy this run: only a pass written below counts.
  rmSync(join(ROOT, VERIFIED_FILE), { force: true })
  const name = expected?.name ?? pkg.name
  const version = opts.version || expected?.version
  const tag = opts.tag || expected?.tag
  if (!version) { console.error(`error: no version — pass <version> or run publish-npm.sh first (it writes ${EXPECTED_FILE})`); return 2 }
  if (!tag) { console.error('error: no dist-tag — pass --tag (the tag is an explicit intent, as in publish-npm.sh)'); return 2 }
  if (expected && expected.version !== version) { console.error(`error: ${expectedPath} is for ${expected.version}, not ${version}`); return 2 }

  console.log(`pull-back: ${name}@${version} (dist-tag ${tag}) from ${opts.registry}`)
  const dist = await checkRegistry(opts, name, version, tag, expected)
  if (dist) await checkTarball(dist)

  if (!opts.registryOnly && results.every((r) => r.ok)) {
    const root = mkdtempSync(join(tmpdir(), 'gotry-pullback-'))
    const cwd = join(root, 'cwd')
    mkdirSync(cwd, { recursive: true })
    const env = cleanRoomEnv(root, opts.registry)
    const spec = `${name}@${version}`
    try {
      checkDoctor(spec, env, cwd, opts.doctorAbsent)
      checkPlugin(findInstalledPackage(env.npm_config_cache, name, version), env, cwd)
      await checkWeb(spec, env, cwd)
      checkOneShot(spec, env, cwd)
    } finally {
      if (opts.keep) console.log(`(kept ${root})`)
      else rmSync(root, { recursive: true, force: true })
    }
  } else if (!opts.registryOnly) {
    console.log('➖ clean room — skipped because a registry check failed')
  }

  const ok = results.length > 0 && results.every((r) => r.ok)
  const receipt = {
    schema: 'gotry_release_verified_v1',
    name, version, tag, ok,
    registry: dist ? { shasum: dist.shasum, integrity: dist.integrity, fileCount: dist.fileCount ?? null, unpackedSize: dist.unpackedSize ?? null, distTags: dist.distTags } : null,
    cleanRoom: !opts.registryOnly,
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    checks: results.map(({ name: n, ok: o }) => ({ name: n, ok: o })),
    verifiedAt: new Date().toISOString(),
  }
  const out = opts.json || (ok && !opts.registryOnly ? join(ROOT, VERIFIED_FILE) : '')
  if (out) writeFileSync(out, `${JSON.stringify(receipt, null, 2)}\n`)
  if (!ok) console.log(`\nPULL-BACK FAILED: ${results.filter((r) => !r.ok).map((r) => r.name).join(', ')} — do not say "published"`)
  else if (opts.registryOnly) console.log(`\nREGISTRY CHECKS PASSED for ${name}@${version} — registry-only, the clean room did not run, so this is not the pull-back`)
  else console.log(`\nPULL-BACK PASSED: ${name}@${version} is published and verified${out ? ` (receipt: ${out})` : ''}`)
  return ok ? 0 : 1
}

if (isMain(import.meta.url)) {
  main().then((code) => process.exit(code), (err) => { console.error(err); process.exit(2) })
}
