#!/usr/bin/env node
/**
 * scripts/release-preflight.mjs — everything about a release that can be known before the founder's first click.
 *
 * The browser approval links last about seven minutes, and a release that fails after the click wastes the
 * founder's time, so every precondition is checked first, in one pass, with all problems listed together:
 *
 *   version      package.json holds a semver; the tag is v<version>
 *   tag          the tag exists locally, HEAD is exactly the tag commit, the tag is on the remote at that
 *                commit, and the commit is on the default branch (reviewed through a PR, not a stray local state)
 *   clean tree   no tracked modifications (the tarball is built from the files on disk)
 *   docs         CHANGELOG.md top section, release-notes.md and release-notes.zh-CN.md all carry the version
 *   CI proof     the exact tree is green: the tag commit's own check runs, or — when push CI was cancelled by
 *                concurrency — the merged PR head with an identical tree. A red or missing proof blocks.
 *   registry     the version is not already published (npm's 403 for that is obscure); the dist-tag intent is
 *                shown, and publishing an older version to a dist-tag that is ahead is refused
 *
 * Usage:
 *   node scripts/release-preflight.mjs --tag <dist-tag> [--version <v>] [--remote origin] [--branch main]
 *        [--repo owner/name] [--registry <url>] [--skip-ci-proof "<reason>"] [--allow-downgrade] [--json <file>]
 *   node scripts/release-preflight.mjs --write-expected --tag <dist-tag>     # after the dist build
 *
 * --write-expected records what `npm pack` produces from the built tree (shasum, integrity, file count) in
 * .release-expected.json; verify-published.mjs later proves the registry serves exactly that.
 * Exit: 0 every check passed; 1 a check failed; 2 usage or environment error.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { EXPECTED_FILE, OFFICIAL_REGISTRY, UsageError, VERIFIED_FILE, compareSemver, fetchPackument, isMain, parseSemver } from './release-lib.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

export function parseArgs(argv) {
  const opts = {
    tag: '', version: '', remote: 'origin', branch: 'main', repo: '', registry: OFFICIAL_REGISTRY,
    skipCiProof: '', allowDowngrade: false, json: '', writeExpected: false,
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const value = () => {
      const v = argv[++i]
      if (v === undefined || v.startsWith('--')) throw new UsageError(`${a} needs a value`)
      return v
    }
    if (a === '--tag') opts.tag = value()
    else if (a === '--version') opts.version = value()
    else if (a === '--remote') opts.remote = value()
    else if (a === '--branch') opts.branch = value()
    else if (a === '--repo') opts.repo = value()
    else if (a === '--registry') opts.registry = value()
    else if (a === '--skip-ci-proof') opts.skipCiProof = value()
    else if (a === '--allow-downgrade') opts.allowDowngrade = true
    else if (a === '--json') opts.json = value()
    else if (a === '--write-expected') opts.writeExpected = true
    else if (a === '-h' || a === '--help') throw new UsageError('')
    else throw new UsageError(`unknown argument ${a}`)
  }
  if (!opts.tag) throw new UsageError('--tag is required: the dist-tag is an explicit intent, never defaulted (#50①)')
  if (!opts.registry.endsWith('/')) opts.registry += '/'
  return opts
}

/** git@github.com:o/r.git, https://github.com/o/r(.git), git+https://… → "o/r"; anything else → "". */
export function parseRepo(url) {
  const m = /github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(url.trim())
  return m ? `${m[1]}/${m[2]}` : ''
}

/** rows: [{name, status, conclusion}] → one verdict for a commit's check runs. */
export function judgeCheckRuns(rows) {
  if (!rows.length) return { state: 'none', detail: 'no check runs' }
  const running = rows.filter((r) => r.status !== 'completed')
  if (running.length) return { state: 'pending', detail: `${running.length} of ${rows.length} still running` }
  const failed = rows.filter((r) => ['failure', 'timed_out', 'action_required', 'startup_failure'].includes(r.conclusion))
  if (failed.length) return { state: 'failed', detail: failed.map((r) => `${r.name}: ${r.conclusion}`).join(', ') }
  const incomplete = rows.filter((r) => !['success', 'skipped', 'neutral'].includes(r.conclusion))
  if (incomplete.length) return { state: 'incomplete', detail: incomplete.map((r) => `${r.name}: ${r.conclusion || r.status}`).join(', ') }
  if (!rows.some((r) => r.conclusion === 'success')) return { state: 'none', detail: 'no check run succeeded' }
  return { state: 'success', detail: `${rows.length} check run(s) green` }
}

function tsv(stdout) {
  return stdout.split('\n').filter(Boolean).map((line) => line.split('\t'))
}

function ghLines(gh, args, what) {
  const r = gh(args)
  if (r.status !== 0) throw new Error(`could not read ${what}: ${(r.stderr || r.stdout || `gh exited ${r.status}`).trim().split('\n')[0]}`)
  return tsv(r.stdout)
}

function checkRunRows(gh, repo, sha) {
  return ghLines(gh, ['api', '--paginate', `repos/${repo}/commits/${sha}/check-runs`, '--jq', '.check_runs[] | [.name, .status, (.conclusion // "")] | @tsv'], `check runs of ${sha.slice(0, 8)}`)
    .map(([name, status, conclusion]) => ({ name, status, conclusion }))
}

/**
 * Is this exact tree green? First the commit's own check runs; push CI is cancelled when merges arrive in quick
 * succession (concurrency group), so otherwise accept the merged PR whose head has an identical tree and green checks.
 */
export function findCiProof({ repo, sha, tree, tagName, gh }) {
  const direct = judgeCheckRuns(checkRunRows(gh, repo, sha))
  if (direct.state === 'success') return { ok: true, detail: `commit ${sha.slice(0, 8)}: ${direct.detail}` }
  if (direct.state === 'failed') return { ok: false, detail: `CI is red on the tag commit ${sha.slice(0, 8)} — ${direct.detail}` }
  const prs = ghLines(gh, ['api', `repos/${repo}/commits/${sha}/pulls`, '--jq', '.[] | [.number, .head.sha, (.merged_at // "")] | @tsv'], `the pull requests of ${sha.slice(0, 8)}`)
    .filter(([, , merged]) => merged)
  for (const [number, headSha] of prs) {
    const headTree = ghLines(gh, ['api', `repos/${repo}/commits/${headSha}`, '--jq', '.commit.tree.sha'], `the tree of ${headSha.slice(0, 8)}`)[0]?.[0]
    if (headTree !== tree) continue
    const judged = judgeCheckRuns(checkRunRows(gh, repo, headSha))
    if (judged.state === 'success') {
      return { ok: true, detail: `PR #${number} head ${headSha.slice(0, 8)} has the identical tree ${tree.slice(0, 8)}; ${judged.detail} (commit checks were ${direct.state})` }
    }
  }
  const remedy = direct.state === 'pending' ? 'CI is still running on the tag commit — wait for it' : `run CI on the tag: gh workflow run CI --ref ${tagName}`
  return {
    ok: false,
    detail: `no green CI proof for tree ${tree.slice(0, 8)}: the commit's checks are ${direct.state} (${direct.detail}) and none of its ${prs.length} merged PR(s) has an identical tree with green checks — ${remedy}`,
  }
}

function realGit(root) {
  return (args) => {
    const r = spawnSync('git', args, { cwd: root, encoding: 'utf8' })
    return { status: r.status, stdout: (r.stdout ?? '').trim(), stderr: (r.stderr ?? '').trim() }
  }
}

function realGh() {
  return (args) => {
    const r = spawnSync(process.env.GOTRY_GH_BIN || 'gh', args, { encoding: 'utf8' })
    return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
  }
}

const read = (path) => (existsSync(path) ? readFileSync(path, 'utf8') : '')

export async function runPreflight(opts, deps = {}) {
  const root = deps.root ?? ROOT
  const git = deps.git ?? realGit(root)
  const gh = deps.gh ?? realGh()
  const getPackument = deps.fetchPackument ?? ((name) => fetchPackument(opts.registry, name))
  const log = deps.log ?? console.log
  const checks = []
  const add = (name, ok, detail) => {
    checks.push({ name, ok, detail })
    log(`${ok ? '✅' : '❌'} ${name} — ${detail}`)
    return ok
  }
  const skip = (name, why) => {
    checks.push({ name, ok: true, skipped: true, detail: why })
    log(`➖ ${name} — skipped: ${why}`)
  }

  const pkg = JSON.parse(read(join(root, 'package.json')) || '{}')
  const version = pkg.version ?? ''
  const tagName = `v${version}`
  if (!parseSemver(version)) add('version', false, `package.json version "${version}" is not a semver`)
  else if (opts.version && opts.version !== version) add('version', false, `package.json is ${version}, not the requested ${opts.version}`)
  else add('version', true, `${pkg.name}@${version}, tag ${tagName}, dist-tag ${opts.tag}`)

  // ---- tag and commit ----
  const peel = git(['rev-parse', '-q', '--verify', `refs/tags/${tagName}^{commit}`])
  const tagCommit = peel.status === 0 ? peel.stdout : ''
  const head = git(['rev-parse', 'HEAD']).stdout
  if (!tagCommit) {
    add('tag', false, `${tagName} does not exist locally — tag the reviewed merge commit first: git tag -a ${tagName} <commit> -m "<why>" && git push ${opts.remote} ${tagName}`)
  } else {
    add('tag', true, `${tagName} → ${tagCommit.slice(0, 8)}`)
    add('HEAD is the tag', head === tagCommit, head === tagCommit
      ? `HEAD ${head.slice(0, 8)}`
      : `HEAD is ${head.slice(0, 8)} but ${tagName} is ${tagCommit.slice(0, 8)} — publish from a checkout of the tag (git switch --detach ${tagName}); a tarball must come from the tagged files`)
    // An annotated tag's own line carries the tag object; its commit is the peeled "^{}" line, which ls-remote
    // only prints when that exact name is asked for. A lightweight tag has just the plain line (the commit).
    const remote = git(['ls-remote', opts.remote, `refs/tags/${tagName}`, `refs/tags/${tagName}^{}`])
    const lines = remote.stdout.split('\n').filter(Boolean).map((l) => l.split('\t'))
    const remoteCommit = (lines.find(([, ref]) => ref === `refs/tags/${tagName}^{}`) ?? lines.find(([, ref]) => ref === `refs/tags/${tagName}`))?.[0] ?? ''
    add('tag on remote', remoteCommit === tagCommit, remoteCommit === tagCommit
      ? `${opts.remote} has ${tagName} at ${remoteCommit.slice(0, 8)}`
      : remoteCommit ? `${opts.remote} has ${tagName} at ${remoteCommit.slice(0, 8)}, local is ${tagCommit.slice(0, 8)}` : `${opts.remote} does not have ${tagName} — push it: git push ${opts.remote} ${tagName} (gh release create --verify-tag needs it)`)
    const fetched = git(['fetch', '--quiet', opts.remote, opts.branch])
    const onBranch = fetched.status === 0 && git(['merge-base', '--is-ancestor', tagCommit, 'FETCH_HEAD']).status === 0
    add(`on ${opts.remote}/${opts.branch}`, onBranch, onBranch
      ? `${tagCommit.slice(0, 8)} is reachable from ${opts.remote}/${opts.branch}`
      : fetched.status !== 0 ? `could not fetch ${opts.remote} ${opts.branch}: ${fetched.stderr.split('\n')[0]}` : `${tagCommit.slice(0, 8)} is not on ${opts.remote}/${opts.branch} — release only reviewed, merged commits`)
  }
  const dirty = git(['status', '--porcelain', '--untracked-files=no']).stdout
  add('clean tree', dirty === '', dirty === '' ? 'no tracked modifications' : `uncommitted changes would not match the tag:\n${dirty}`)

  // ---- docs that must already carry the version (they are part of the tagged tree) ----
  const changelog = read(join(root, 'CHANGELOG.md')).split('\n').slice(0, 30).join('\n')
  const notes = { en: read(join(root, 'docs/release-notes.md')), zh: read(join(root, 'docs/release-notes.zh-CN.md')) }
  // "## v0.2.0" must not be satisfied by "## v0.2.0-rc.28": the version is followed by space or end of line.
  const heading = new RegExp(`^## v${version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=\\s|$)`, 'm')
  const missing = [
    !changelog.includes(`## [${version}]`) && 'CHANGELOG.md top section',
    !heading.test(notes.en) && 'docs/release-notes.md',
    !heading.test(notes.zh) && 'docs/release-notes.zh-CN.md',
  ].filter(Boolean)
  add('release docs', missing.length === 0, missing.length === 0 ? `CHANGELOG and both release-notes carry ${version}` : `missing the ${version} section: ${missing.join(', ')}`)

  // ---- CI proof for the exact tree ----
  if (opts.skipCiProof) {
    skip('CI proof', opts.skipCiProof)
  } else if (!tagCommit) {
    skip('CI proof', 'no tag commit to prove')
  } else {
    const repo = opts.repo || parseRepo(git(['remote', 'get-url', opts.remote]).stdout)
    const tree = git(['rev-parse', `${tagCommit}^{tree}`]).stdout
    if (!repo) add('CI proof', false, `cannot tell the GitHub repository from remote "${opts.remote}" — pass --repo owner/name`)
    else {
      try {
        const proof = findCiProof({ repo, sha: tagCommit, tree, tagName, gh })
        add('CI proof', proof.ok, proof.detail)
      } catch (err) {
        add('CI proof', false, `${err.message} (a deliberate bypass needs --skip-ci-proof "<reason>")`)
      }
    }
  }

  // ---- registry state ----
  if (parseSemver(version) && pkg.name) {
    try {
      const pk = await getPackument(pkg.name)
      if (pk?.versions?.[version]) add('registry', false, `${pkg.name}@${version} is already published — a version can never be republished`)
      else {
        const current = pk?.['dist-tags']?.[opts.tag]
        const order = current ? compareSemver(version, current) : null
        if (order !== null && order <= 0 && !opts.allowDowngrade) {
          add('registry', false, `dist-tag ${opts.tag} is already at ${current}, which is not older than ${version} — pass --allow-downgrade only if moving the tag backwards is intended`)
        } else {
          add('registry', true, `${version} is not published; dist-tag ${opts.tag} → ${current ?? '(unset)'}`)
        }
      }
    } catch (err) {
      add('registry', false, `could not read the registry: ${err.message}`)
    }
  }

  return { ok: checks.every((c) => c.ok), checks, version, tagName, commit: tagCommit || head }
}

/** Run after the dist build: what `npm pack` makes from this tree is what the registry must serve. */
export function writeExpected({ root = ROOT, tag, run = spawnSync, git = realGit(root), now = () => new Date() }) {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  const r = run('npm', ['pack', '--dry-run', '--json'], { cwd: root, encoding: 'utf8', maxBuffer: 64 << 20 })
  if (r.status !== 0) throw new Error(`npm pack --dry-run failed: ${(r.stderr ?? '').trim().split('\n').slice(-2).join(' ')}`)
  const packed = JSON.parse(r.stdout)[0]
  if (!packed || packed.version !== pkg.version) throw new Error(`npm pack describes ${packed?.name}@${packed?.version}, package.json is ${pkg.version}`)
  const expected = {
    schema: 'gotry_release_expected_v1',
    name: pkg.name,
    version: pkg.version,
    tag,
    commit: git(['rev-parse', 'HEAD']).stdout,
    tree: git(['rev-parse', 'HEAD^{tree}']).stdout,
    shasum: packed.shasum,
    integrity: packed.integrity,
    fileCount: packed.entryCount,
    unpackedSize: packed.unpackedSize,
    expectedAt: now().toISOString(),
  }
  writeFileSync(join(root, EXPECTED_FILE), `${JSON.stringify(expected, null, 2)}\n`)
  return expected
}

async function main() {
  let opts
  try { opts = parseArgs(process.argv.slice(2)) } catch (err) {
    if (err instanceof UsageError) {
      console.error(`${err.message ? `error: ${err.message}\n` : ''}usage: node scripts/release-preflight.mjs --tag <dist-tag> [--version <v>] [--remote origin] [--branch main] [--repo owner/name] [--registry <url>] [--skip-ci-proof "<reason>"] [--allow-downgrade] [--json <file>]\n       node scripts/release-preflight.mjs --write-expected --tag <dist-tag>`)
      return 2
    }
    throw err
  }
  if (opts.writeExpected) {
    const e = writeExpected({ tag: opts.tag })
    console.log(`expected build recorded in ${EXPECTED_FILE}: ${e.name}@${e.version} shasum ${e.shasum}, ${e.fileCount} files, ${e.unpackedSize} unpacked bytes`)
    return 0
  }
  // Records of an earlier release must not outlive the start of this one.
  rmSync(join(ROOT, EXPECTED_FILE), { force: true })
  rmSync(join(ROOT, VERIFIED_FILE), { force: true })
  const result = await runPreflight(opts)
  if (opts.json) writeFileSync(opts.json, `${JSON.stringify(result, null, 2)}\n`)
  console.log(result.ok ? `\nPREFLIGHT PASSED: ${result.tagName} (${result.commit.slice(0, 8)}) is ready for the approval click` : `\nPREFLIGHT FAILED: ${result.checks.filter((c) => !c.ok).map((c) => c.name).join(', ')} — nothing was sent to the registry`)
  return result.ok ? 0 : 1
}

if (isMain(import.meta.url)) {
  main().then((code) => process.exit(code), (err) => { console.error(err); process.exit(2) })
}
