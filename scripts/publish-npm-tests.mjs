#!/usr/bin/env node
/**
 * Orchestration tests for scripts/publish-npm.sh.
 *
 * The script is the glue between the release tools, so what it must get right is ORDER and REFUSAL: nothing may
 * be published before the preflight passed, no GitHub Release before the pull-back passed, no session revoked
 * while a failure could still need it, and a long-lived .env token must never be revoked. Each scenario runs the
 * real script in a throwaway git repo whose npm/gh are fakes and whose preflight/build/verify stages are stubs
 * that log their arguments. No network, no registry, no browser. Every scenario runs under `sh` and, when
 * installed, `dash` (the script is POSIX sh; the previous version only worked where /bin/sh is bash).
 *
 * Not covered here: the interactive Enter prompt (needs a TTY) and the real stages — those have their own suites.
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
let checks = 0
const ok = (cond, msg) => { assert.ok(cond, msg); checks++ }
const eq = (a, b, msg) => { assert.deepEqual(a, b, msg); checks++ }

const shells = ['sh', ...(spawnSync('dash', ['-c', 'exit 0']).status === 0 ? ['dash'] : [])]

const FAKE_NPM = `#!/bin/sh
echo "npm $*" >> "$STUB_LOG"
case "$1" in
  whoami)
    if grep -q '_authToken=' "$NPM_CONFIG_USERCONFIG" 2>/dev/null; then echo tester; exit 0; fi
    exit 1 ;;
  login)
    echo '//registry.npmjs.org/:_authToken=session-token-123' >> "$NPM_CONFIG_USERCONFIG"
    exit 0 ;;
  logout)
    if [ "\${STUB_LOGOUT_EXIT:-0}" = 0 ]; then sed -i.bak '/_authToken=/d' "$NPM_CONFIG_USERCONFIG"; rm -f "$NPM_CONFIG_USERCONFIG.bak"; fi
    exit "\${STUB_LOGOUT_EXIT:-0}" ;;
  config) echo "https://registry.npmjs.org/"; exit 0 ;;
  publish)
    dir=""; prev=""
    for a in "$@"; do if [ "$prev" = "--logs-dir" ]; then dir="$a"; fi; prev="$a"; done
    case "\${STUB_PUBLISH:-ok}" in
      ok) exit 0 ;;
      expired)
        echo "npm error code E404" >&2
        echo "http fetch GET 404 https://registry.npmjs.org/-/v1/done?authId=*** 12ms" > "$dir/debug-0.log"
        exit 1 ;;
      duplicate)
        echo "npm error You cannot publish over the previously published versions" >&2
        echo "error You cannot publish over the previously published versions: 1.2.3." > "$dir/debug-0.log"
        exit 1 ;;
      other) echo "npm error boom" >&2; exit 7 ;;
    esac ;;
esac
exit 0
`
const FAKE_GH = `#!/bin/sh
echo "gh $*" >> "$STUB_LOG"
prev=""
for a in "$@"; do if [ "$prev" = "--notes-file" ]; then cp "$a" "$STUB_NOTES_COPY"; fi; prev="$a"; done
exit "\${STUB_GH_EXIT:-0}"
`
const stage = (name, body) => `import { appendFileSync, writeFileSync } from 'node:fs'
const args = process.argv.slice(2)
appendFileSync(process.env.STUB_LOG, \`node ${name} \${args.join(' ')}\\n\`)
${body}
`

function makeRoot({ envToken = '', withGh = true, npmScript = FAKE_NPM } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'gotry-publish-sh-'))
  mkdirSync(join(root, 'scripts'))
  mkdirSync(join(root, 'docs'))
  mkdirSync(join(root, 'bin'))
  for (const f of ['publish-npm.sh', 'release-notes.mjs', 'release-lib.mjs']) copyFileSync(join(HERE, f), join(root, 'scripts', f))
  writeFileSync(join(root, 'scripts/release-preflight.mjs'), stage('release-preflight.mjs',
    "const writing = args.includes('--write-expected')\nconst code = Number((writing ? process.env.STUB_WRITE_EXPECTED_EXIT : process.env.STUB_PREFLIGHT_EXIT) ?? 0)\nif (!code && writing) writeFileSync('.release-expected.json', '{}')\nprocess.exit(code)"))
  writeFileSync(join(root, 'scripts/build-dist.mjs'), stage('build-dist.mjs', 'process.exit(Number(process.env.STUB_BUILD_EXIT ?? 0))'))
  writeFileSync(join(root, 'scripts/verify-published.mjs'), stage('verify-published.mjs',
    "const code = Number(process.env.STUB_VERIFY_EXIT ?? 0)\nif (!code) writeFileSync('.release-verified.json', '{\"ok\":true}')\nprocess.exit(code)"))
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: '@scope/pkg', version: '1.2.3' }))
  writeFileSync(join(root, 'CHANGELOG.md'), '# Changelog\n\n## [1.2.3] - 2026-10-06\n\n### Fixed\n\n- generated line\n')
  writeFileSync(join(root, 'docs/release-notes.md'), '# Notes\n\n---\n\n## v1.2.3 · 2026-10-06\n\nwritten line\n\n---\n')
  if (envToken) writeFileSync(join(root, '.env'), `NPM_TOKEN=${envToken}\n`)
  writeFileSync(join(root, 'bin/npm'), npmScript)
  if (withGh) writeFileSync(join(root, 'bin/gh'), FAKE_GH)
  for (const f of ['npm', ...(withGh ? ['gh'] : [])]) chmodSync(join(root, 'bin', f), 0o755)
  symlinkSync(process.execPath, join(root, 'bin/node'))
  const git = (...a) => spawnSync('git', ['-c', 'commit.gpgsign=false', '-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd: root, env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } })
  git('init', '-q')
  git('add', '-A')
  git('commit', '-q', '-m', 'init')
  return root
}

function run(root, shell, args, env = {}) {
  const log = join(root, 'calls.log')
  const r = spawnSync(shell, [join(root, 'scripts/publish-npm.sh'), ...args], {
    cwd: root,
    encoding: 'utf8',
    timeout: 60_000,
    input: '',
    env: {
      PATH: `${join(root, 'bin')}:/usr/bin:/bin:/usr/sbin:/sbin`,
      HOME: root,
      TMPDIR: root,
      STUB_LOG: log,
      STUB_NOTES_COPY: join(root, 'gh-notes.md'),
      ...env,
    },
  })
  const calls = existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean) : []
  return { status: r.status, out: `${r.stdout}${r.stderr}`, calls, root }
}

const has = (calls, re) => calls.some((c) => re.test(c))
const indexOf = (calls, re) => calls.findIndex((c) => re.test(c))
function inOrder(calls, res, msg) {
  let last = -1
  for (const re of res) {
    const i = calls.findIndex((c, k) => k > last && re.test(c))
    assert.ok(i > last, `${msg}: ${re} should come after position ${last}\n${calls.join('\n')}`)
    last = i
  }
  checks++
}

const roots = []
const scenario = (shell, opts, args, env) => {
  const root = makeRoot(opts)
  roots.push(root)
  return run(root, shell, args, env)
}

for (const shell of shells) {
  const tag = (m) => `[${shell}] ${m}`
  const Y = ['--yes']
  const T = { TAG: 'latest' }

  // ---- refusals before anything runs ----
  {
    const r = scenario(shell, {}, [], {})
    ok(r.status === 1 && /TAG 未指定/.test(r.out), tag('no TAG is refused'))
    eq(r.calls, [], tag('and nothing ran'))
    const pos = scenario(shell, {}, ['latest'], T)
    ok(pos.status === 1 && /未知子命令 'latest'/.test(pos.out) && pos.calls.length === 0, tag('a positional dist-tag is refused (it must be TAG=…)'))
    const stray = scenario(shell, {}, ['--yes', 'latest'], T)
    ok(stray.status === 1 && /发布不接受位置参数/.test(stray.out) && stray.calls.length === 0, tag('a positional argument after a flag is refused too'))
    const typo = scenario(shell, {}, ['--keep-sesion', '--yes'], T)
    ok(typo.status === 1 && /未知选项 --keep-sesion/.test(typo.out) && typo.calls.length === 0, tag('a mistyped option is refused, not ignored'))
    const help = scenario(shell, {}, ['--help'], {})
    ok(help.status === 0 && /用法:/.test(help.out) && /--keep-session/.test(help.out) && help.calls.length === 0, tag('--help prints the usage and runs nothing'))
  }

  // ---- the happy path: the whole chain, in order ----
  {
    const r = scenario(shell, {}, Y, T)
    eq(r.status, 0, tag(`happy path exits 0\n${r.out}`))
    inOrder(r.calls, [
      /^node release-preflight\.mjs --tag latest$/,
      /^node build-dist\.mjs/,
      /^node release-preflight\.mjs --write-expected --tag latest$/,
      /^npm whoami/,
      /^npm login --auth-type=web/,
      /^npm publish --access public --tag latest --registry=https:\/\/registry\.npmjs\.org\/ --logs-dir /,
      /^node verify-published\.mjs --tag latest$/,
      /^gh release create v1\.2\.3 --title v1\.2\.3 --notes-file .+ --verify-tag$/,
      /^npm logout/,
    ], tag('stages run preflight → build → expected → login → publish → verify → release → logout'))
    ok(!existsSync(join(r.root, '.npmrc.publish')), tag('the session file is removed after success'))
    ok(existsSync(join(r.root, '.release-verified.json')), tag('the receipt is left for post-release-docs'))
    const notes = readFileSync(join(r.root, 'gh-notes.md'), 'utf8')
    ok(notes.startsWith('written line') && notes.includes('generated line') && notes.includes('\n---\n'), tag('the Release body is the written notes above the generated section'))
    ok(/post-release-docs\.mjs --receipt .*\.release-verified\.json/.test(r.out), tag('the next step names post-release-docs with the receipt path'))
    ok(r.calls.every((c) => !/^npm .*--userconfig/.test(c)), tag('no call overrides the isolated config'))
  }

  // ---- the preflight is the first gate ----
  {
    const r = scenario(shell, {}, Y, { ...T, STUB_PREFLIGHT_EXIT: '1' })
    ok(r.status === 1 && /预检未过/.test(r.out), tag('a failed preflight stops the run'))
    eq(r.calls, ['node release-preflight.mjs --tag latest'], tag('nothing else ran: no build, no npm'))
    const ci = scenario(shell, {}, Y, { ...T, SKIP_CI_PROOF: 'push CI cancelled by concurrency; PR head tree identical', ALLOW_DOWNGRADE: '1' })
    ok(has(ci.calls, /^node release-preflight\.mjs --tag latest --skip-ci-proof push CI cancelled by concurrency; PR head tree identical --allow-downgrade$/), tag('SKIP_CI_PROOF and ALLOW_DOWNGRADE reach the preflight'))
    const skip = scenario(shell, {}, [...Y, '--skip-preflight'], T)
    ok(skip.status === 0 && /--skip-preflight/.test(skip.out), tag('--skip-preflight is loud and lets the run continue'))
    ok(!has(skip.calls, /^node release-preflight\.mjs --tag latest$/) && has(skip.calls, /--write-expected/), tag('--skip-preflight skips the checks but still records the expected build'))
    const noExpected = scenario(shell, {}, Y, { ...T, STUB_WRITE_EXPECTED_EXIT: '1' })
    ok(noExpected.status === 1 && /记录预期构建失败/.test(noExpected.out) && !has(noExpected.calls, /^npm (login|publish)/), tag('no expected build, no publish'))
    const build = scenario(shell, {}, Y, { ...T, STUB_BUILD_EXIT: '1' })
    ok(build.status !== 0 && !has(build.calls, /^npm (login|publish)/) && !has(build.calls, /write-expected/), tag('a failed dist build stops before anything is recorded or published'))
  }

  // ---- presence: no browser click is requested without someone confirming they are there ----
  {
    const r = scenario(shell, {}, [], T)
    ok(r.status === 1 && /非交互终端/.test(r.out) && /--yes/.test(r.out), tag('non-interactive without --yes is refused with the reason'))
    ok(has(r.calls, /^node release-preflight\.mjs --tag latest$/) && has(r.calls, /^node build-dist/) && has(r.calls, /--write-expected/), tag('the preflight and build still ran, so problems surface first'))
    ok(!has(r.calls, /^npm (login|publish)/), tag('but no login or publish was started'))
  }

  // ---- publish failures: the hint, and nothing after ----
  {
    const r = scenario(shell, {}, Y, { ...T, STUB_PUBLISH: 'expired' })
    ok(r.status === 1, tag('an expired approval link fails the run'))
    ok(/批准链接过期/.test(r.out) && /误导性报错/.test(r.out) && /什么都没发布/.test(r.out), tag('the misleading E404 on /-/v1/done is explained'))
    ok(!has(r.calls, /^node verify-published/) && !has(r.calls, /^gh /) && !has(r.calls, /^npm logout/), tag('no verify, no Release, no logout after a failed publish'))
    ok(existsSync(join(r.root, '.npmrc.publish')), tag('the session survives a failed publish so a retry costs one click less'))
    const dup = scenario(shell, {}, Y, { ...T, STUB_PUBLISH: 'duplicate' })
    ok(dup.status === 1 && /已发布过/.test(dup.out) && /verify-published\.mjs --tag latest/.test(dup.out), tag('a duplicate version points at the pull-back, not at republishing'))
    const other = scenario(shell, {}, Y, { ...T, STUB_PUBLISH: 'other' })
    eq(other.status, 7, tag("npm's own exit code is passed through"))
    ok(/npm publish 失败\(退出码 7\)/.test(other.out) && /gotry-publish-logs/.test(other.out), tag('an unrecognised failure names the npm log directory'))
  }

  // ---- the pull-back gates the Release and the session ----
  {
    const r = scenario(shell, {}, Y, { ...T, STUB_VERIFY_EXIT: '1' })
    ok(r.status === 1 && /回拉校验未过/.test(r.out) && /不得说「已发布」/.test(r.out), tag('a failed pull-back fails the run and says not to claim published'))
    ok(!has(r.calls, /^gh /) && !has(r.calls, /^npm logout/), tag('no Release and no logout after a failed pull-back'))
    ok(existsSync(join(r.root, '.npmrc.publish')) && !existsSync(join(r.root, '.release-verified.json')), tag('the session stays and there is no receipt'))
    const nv = scenario(shell, {}, [...Y, '--no-verify'], T)
    ok(nv.status === 0 && /--no-verify/.test(nv.out) && /不得说「已发布」/.test(nv.out), tag('--no-verify is loud about what it forfeits'))
    ok(!has(nv.calls, /^node verify-published/) && !has(nv.calls, /^gh /) && !has(nv.calls, /^npm logout/), tag('--no-verify creates no Release and keeps the session'))
  }

  // ---- the Release is best-effort after a verified publish; the session is still ended ----
  {
    const r = scenario(shell, {}, Y, { ...T, STUB_GH_EXIT: '1' })
    ok(r.status === 0 && /gh release create 失败/.test(r.out) && /release-notes\.mjs --out/.test(r.out), tag('a failed gh does not fail a verified publish; the manual recovery is printed'))
    ok(has(r.calls, /^npm logout/) && existsSync(join(r.root, '.release-verified.json')), tag('the session is still ended and the receipt kept'))
    const nogh = scenario(shell, { withGh: false }, Y, T)
    ok(nogh.status === 0 && !has(nogh.calls, /^gh /), tag('without gh installed the publish still completes'))
    const skipCl = scenario(shell, {}, [...Y, '--skip-changelog'], T)
    ok(skipCl.status === 0 && !has(skipCl.calls, /^gh /), tag('--skip-changelog keeps its old meaning: no changelog gate, no Release'))
  }

  // ---- sessions: only a web session is ever revoked ----
  {
    const keep = scenario(shell, {}, [...Y, '--keep-session'], T)
    ok(keep.status === 0 && !has(keep.calls, /^npm logout/) && existsSync(join(keep.root, '.npmrc.publish')) && /--keep-session/.test(keep.out), tag('--keep-session leaves the session in place'))
    const envTok = scenario(shell, { envToken: 'long-lived-env-token' }, Y, T)
    ok(envTok.status === 0 && !has(envTok.calls, /^npm login/), tag('a valid .env token needs no web login'))
    ok(!has(envTok.calls, /^npm logout/), tag('the long-lived .env token is never revoked'))
    ok(!existsSync(join(envTok.root, '.npmrc.publish')), tag('but the generated session file is still removed'))
    const failLogout = scenario(shell, {}, Y, { ...T, STUB_LOGOUT_EXIT: '1' })
    ok(failLogout.status === 0 && /npm logout 没成功/.test(failLogout.out) && !existsSync(join(failLogout.root, '.npmrc.publish')), tag('a failed logout is reported with the manual fix, and the file is still removed'))
  }

  // ---- subcommands ----
  {
    const login = scenario(shell, {}, ['login'], {})
    ok(login.status === 0 && has(login.calls, /^npm login --auth-type=web/), tag('login needs no TAG and runs npm login'))
    ok(!has(login.calls, /^node /) && existsSync(join(login.root, '.npmrc.publish')), tag('login runs no stage and leaves the session for the publish'))

    const lo = makeRoot()
    roots.push(lo)
    writeFileSync(join(lo, '.npmrc.publish'), 'registry=https://registry.npmjs.org/\n//registry.npmjs.org/:_authToken=session-token-123\n')
    const out1 = run(lo, shell, ['logout'], {})
    ok(out1.status === 0 && has(out1.calls, /^npm logout/) && !existsSync(join(lo, '.npmrc.publish')), tag('logout revokes a web session and removes the file'))
    ok(!has(out1.calls, /^npm whoami/), tag('logout does not first re-validate (and so never writes the .env token in)'))

    const loEnv = makeRoot({ envToken: 'long-lived-env-token' })
    roots.push(loEnv)
    writeFileSync(join(loEnv, '.npmrc.publish'), 'registry=https://registry.npmjs.org/\n//registry.npmjs.org/:_authToken=long-lived-env-token\n')
    const out2 = run(loEnv, shell, ['logout'], {})
    ok(out2.status === 0 && !has(out2.calls, /^npm logout/) && !existsSync(join(loEnv, '.npmrc.publish')), tag('logout never revokes the .env token, only deletes the file'))

    const loNone = scenario(shell, {}, ['logout'], {})
    ok(loNone.status === 0 && loNone.calls.length === 0, tag('logout with no session is a no-op'))

    const rm0 = scenario(shell, {}, ['rmtag'], {})
    ok(rm0.status === 1 && /至少一个通道名/.test(rm0.out), tag('rmtag without names is refused'))
    const rmLatest = scenario(shell, {}, ['rmtag', 'rc.5', 'latest', '--yes'], {})
    ok(rmLatest.status === 1 && /拒绝删除 latest/.test(rmLatest.out) && !has(rmLatest.calls, /dist-tag/), tag('rmtag refuses to remove latest, before removing anything'))
    const rmNoYes = scenario(shell, {}, ['rmtag', 'rc.5'], {})
    ok(rmNoYes.status === 1 && /非交互终端/.test(rmNoYes.out) && !has(rmNoYes.calls, /dist-tag/), tag('rmtag needs --yes when non-interactive'))
    const rm = scenario(shell, {}, ['rmtag', 'rc.5', '--yes', 'rc.11'], {})
    ok(rm.status === 0, tag(`rmtag runs\n${rm.out}`))
    eq(rm.calls.filter((c) => /dist-tag/.test(c)), [
      'npm dist-tag rm @danceiny/gotry rc.5 --registry=https://registry.npmjs.org/',
      'npm dist-tag rm @danceiny/gotry rc.11 --registry=https://registry.npmjs.org/',
    ], tag('every named tag is removed, and the --yes flag is not mistaken for a tag'))
    ok(has(rm.calls, /^npm login/), tag('rmtag logs in when there is no session'))
    ok(/每个一次浏览器批准|每个 tag/.test(rm.out) || has(rm.calls, /dist-tag/), tag('rmtag is explicit that each removal is an approval'))
  }

  // ---- isolation: every npm call sees the repo-local userconfig, never ~/.npmrc ----
  {
    const root = makeRoot({ npmScript: FAKE_NPM.replace('echo "npm $*" >> "$STUB_LOG"', 'echo "npm $* [userconfig=$NPM_CONFIG_USERCONFIG]" >> "$STUB_LOG"') })
    roots.push(root)
    const r = run(root, shell, Y, T)
    const npmCalls = r.calls.filter((c) => c.startsWith('npm '))
    ok(npmCalls.length > 3 && npmCalls.every((c) => c.endsWith(`[userconfig=${join(root, '.npmrc.publish')}]`)), tag('all npm calls run with NPM_CONFIG_USERCONFIG=<repo>/.npmrc.publish'))
  }
}

// ---- the script must parse as POSIX sh ----
for (const shell of shells) {
  const r = spawnSync(shell, ['-n', join(HERE, 'publish-npm.sh')], { encoding: 'utf8' })
  ok(r.status === 0, `${shell} -n accepts publish-npm.sh: ${r.stderr}`)
}

for (const root of roots) rmSync(root, { recursive: true, force: true })
console.log(`PUBLISH-NPM TESTS: ${checks} checks OK (${shells.join(', ')})`)
