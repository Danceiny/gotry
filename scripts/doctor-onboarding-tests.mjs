// #651: exercise the npm CLI against isolated browser profiles and credentials.
// A store install must not depend on ~/.gotry/extension, and a staged directory
// must not be advertised as a connected browser. No real user state is used.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repo = join(dirname(fileURLToPath(import.meta.url)), '..')
const root = mkdtempSync(join(tmpdir(), 'gotry-doctor-onboarding-'))
const pkg = join(root, 'package')
cpSync(join(repo, 'bin'), join(pkg, 'bin'), { recursive: true })
writeFileSync(join(pkg, 'package.json'), JSON.stringify({ type: 'module', version: 'test' }))
const entry = join(pkg, 'bin', 'gotry-inner.js')
// pnpm .bin/gotry is a shell launcher, whereas the fixture entry is JavaScript.
const command = process.argv[2] || process.execPath
const prefix = process.argv[2] ? [] : [entry]
const storeId = 'oeajpiccmonococjcegddlooeeohlbgd'
let isolatedBridgePort = 0
const preload = pathToFileURL(join(repo, 'scripts', 'doctor-test-isolation.mjs')).href

function home(name) { const path = join(root, name); mkdirSync(path); return path }
function envFor(homeDir) {
  return {
    // The pnpm launcher needs dirname/sed/uname before it invokes Node.
    PATH: [dirname(process.execPath), '/usr/bin', '/bin'].join(delimiter), HOME: homeDir, USERPROFILE: homeDir,
    LOCALAPPDATA: join(homeDir, 'AppData', 'Local'), XDG_CONFIG_HOME: join(homeDir, '.config'),
    DSH_HOME: join(homeDir, '.dsh'), GOTRY_SETUP_HBCLI: '0',
    GOTRY_SETUP_REACH: '0', GOTRY_SETUP_SIDEBAR: '0',
    NODE_OPTIONS: `--import=${preload}`, GOTRY_TEST_DOCTOR_PORT: String(isolatedBridgePort),
  }
}
function browserRoot(homeDir, platform = process.platform) {
  if (platform === 'darwin') return join(homeDir, 'Library', 'Application Support', 'Google', 'Chrome')
  if (platform === 'win32') return join(homeDir, 'AppData', 'Local', 'Google', 'Chrome', 'User Data')
  return join(homeDir, '.config', 'google-chrome')
}
function installStore(homeDir, disabled = false, profileName = 'Default', platform = process.platform) {
  const profile = join(browserRoot(homeDir, platform), profileName)
  const dir = join(profile, 'Extensions', storeId, '0.2.0.27_0')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ manifest_version: 3, name: 'Stai Travel Bridge', version: '0.2.0.27' }))
  // Current Chrome may omit state and use disable_reasons instead.
  writeFileSync(join(profile, 'Secure Preferences'), JSON.stringify({ extensions: { settings: {
    [storeId]: { path: `${storeId}/0.2.0.27_0`, disable_reasons: disabled ? [1] : [] },
  } } }))
}
function cli(homeDir, args, input = '') {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...prefix, ...args], { cwd: root, env: envFor(homeDir), stdio: ['pipe', 'pipe', 'pipe'] })
    let output = ''
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('CLI timeout')) }, 15_000)
    child.stdout.on('data', d => { output += d })
    child.stderr.on('data', d => { output += d })
    child.on('error', reject)
    child.on('close', code => { clearTimeout(timer); resolve({ code, output }) })
    child.stdin.end(input)
  })
}
const extensionLine = output => output.split('\n').find(line => /(?:✅|⚠️|❌) Stai Travel Bridge/.test(line)) ?? ''

// Use a real terminal so an implementation that only prints instructions, or
// echoes the secret before entering raw mode, cannot pass this regression.
function terminal(homeDir, answer, key, extra = {}, interruptSignal) {
  const pty = createRequire(join(repo, 'ts', 'package.json'))('node-pty')
  return new Promise((resolve, reject) => {
    // Direct bootstrap isolates the interrupted doctor owner from the outer
    // synchronous CLI dispatcher, which shares the terminal process group.
    const child = pty.spawn(interruptSignal ? process.execPath : command,
      [...(interruptSignal ? [join(pkg, 'bin', 'gotry-bootstrap.js')] : prefix), 'doctor', '--fix'],
      { cwd: root, env: { ...envFor(homeDir), ...extra }, cols: 160, rows: 30 })
    let output = '', answered = false, submitted = false, interrupted = false
    const interruptTimer = interruptSignal ? setInterval(() => {
      if (!interrupted && existsSync(join(homeDir, 'verifier-pid'))) {
        interrupted = true
        process.kill(child.pid, interruptSignal)
      }
    }, 20) : undefined
    const timer = setTimeout(() => { clearInterval(interruptTimer); child.kill(); reject(new Error('terminal timeout: ' + output)) }, 15_000)
    const collect = chunk => {
      output += chunk
      if (!answered && output.includes('现在配置 FlyAI')) { answered = true; child.write(answer + '\r') }
      if (!submitted && output.includes('  key: ')) { submitted = true; child.write(key + '\r') }
    }
    child.onData(collect)
    child.onExit(({ exitCode }) => { clearTimeout(timer); clearInterval(interruptTimer); resolve({ code: exitCode, output, answered, submitted }) })
  })
}

try {
  const installedHome = home('store-installed')
  installStore(installedHome, false, 'Profile 2')
  const installedRun = await cli(installedHome, ['doctor'])
  const installed = extensionLine(installedRun.output)
  assert.match(installed, /⚠️.*已安装/, 'a Chrome Store installation must be detected without the unpacked staging directory: ' + installedRun.output)
  assert.doesNotMatch(installed, /未安装|账号会话通道\)不可用/, 'an offline check cannot assert that an installed account channel is unavailable')
  console.log('store profile install detected without local staging: OK')

  const disabledHome = home('store-disabled')
  installStore(disabledHome, true)
  assert.match(extensionLine((await cli(disabledHome, ['doctor'])).output), /⚠️.*已安装.*停用/)
  const unknownHome = home('unknown')
  const unknown = extensionLine((await cli(unknownHome, ['doctor'])).output)
  assert.match(unknown, /⚠️/)
  assert.doesNotMatch(unknown, /未安装|账号会话通道\)不可用/)
  const stagedHome = home('staged')
  mkdirSync(join(stagedHome, '.gotry', 'extension'), { recursive: true })
  writeFileSync(join(stagedHome, '.gotry', 'extension', 'manifest.json'), '{}')
  assert.match(extensionLine((await cli(stagedHome, ['doctor'])).output), /⚠️.*本地.*未确认/)
  console.log('disabled, unknown and staged-only states do not claim readiness: OK')

  const { checkExtensionStatus } = await import('../bin/gotry-extension-status.js')
  for (const platform of ['darwin', 'linux', 'win32']) {
    const platformHome = home(platform)
    installStore(platformHome, false, 'Profile 1', platform)
    const status = await checkExtensionStatus({ homeDir: platformHome, platform, env: envFor(platformHome), ports: [] })
    assert.equal(status.status, 'degraded')
    assert.match(status.detail, /已安装/)
  }
  console.log('Chrome profile discovery on macOS, Linux and Windows: OK')
  const leftoverHome = home('uninstalled-leftovers')
  installStore(leftoverHome)
  writeFileSync(join(browserRoot(leftoverHome), 'Default', 'Secure Preferences'), '{}')
  const leftover = await checkExtensionStatus({ homeDir: leftoverHome, env: envFor(leftoverHome), ports: [] })
  assert.doesNotMatch(leftover.detail, /已安装/, 'leftover extension files without a browser installation record cannot prove installation')

  let bridgeReply = { ok: true, protocol: 'session-bridge.v1', extensionConnected: true, lastSeenMsAgo: 10, queued: 0, inFlight: 0, parked: 0 }
  const server = createServer((req, res) => {
    assert.equal(req.method, 'GET')
    assert.equal(req.url, '/status', 'doctor must not call the heartbeat or submit jobs')
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify(bridgeReply))
  })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  isolatedBridgePort = server.address().port
  try {
    assert.match(extensionLine((await cli(unknownHome, ['doctor'])).output), /✅.*已连接/)
    bridgeReply = { ...bridgeReply, protocol: 'unrelated-service' }
    assert.doesNotMatch(extensionLine((await cli(unknownHome, ['doctor'])).output), /✅/)
    bridgeReply = { ...bridgeReply, protocol: 'session-bridge.v1', lastSeenMsAgo: 45_000 }
    assert.doesNotMatch(extensionLine((await cli(unknownHome, ['doctor'])).output), /✅/)
  } finally { await new Promise(resolve => server.close(resolve)); isolatedBridgePort = 0 }
  console.log('read-only bridge status proves a current connection: OK')

  const help = await cli(unknownHome, ['help'])
  assert.match(help.output, /gotry setup flyai/)
  const doctor = await cli(unknownHome, ['doctor'])
  assert.match(doctor.output, /npx @danceiny\/gotry setup flyai/, 'npm users need a directly executable setup command')
  const fixed = await cli(unknownHome, ['doctor', '--fix'])
  assert.doesNotMatch(fixed.output, /现在配置 FlyAI.*y\/N/, 'a non-TTY must not ask for credentials')
  assert.ok(!existsSync(join(unknownHome, '.flyai', 'config.json')))
  console.log('discoverable npm setup and non-TTY credential boundary: OK')

  if (process.platform !== 'win32') {
    const key = 'sk-isolated-doctor-key-1234'
    const verifier = join(root, 'flyai-verifier')
    writeFileSync(verifier, `#!${process.execPath}\nif (process.env.FAKE_FLYAI_RESULT === 'auth-error') { console.error('HTTP 401 Invalid API key'); process.exit(1) }\nconsole.log(JSON.stringify({ data: { itemList: [] } }))\n`, { mode: 0o700 })
    const configuredHome = home('guided')
    const configured = await terminal(configuredHome, 'y', key, { GOTRY_FLYAI_CLI_BIN: verifier })
    assert.equal(configured.answered, true, 'doctor --fix must offer the existing FlyAI setup flow on an interactive terminal: ' + configured.output)
    assert.equal(configured.submitted, true)
    assert.doesNotMatch(configured.output, new RegExp(key), 'terminal output must not echo the credential')
    assert.equal(JSON.parse(readFileSync(join(configuredHome, '.flyai', 'config.json'), 'utf8')).FLYAI_API_KEY, key)
    assert.match(configured.output, /FlyAI.*已验证.*来源 config/, 'the final recheck must reflect the newly verified file')
    const healthy = await terminal(configuredHome, 'y', key, { GOTRY_FLYAI_CLI_BIN: verifier })
    assert.equal(healthy.answered, false, 'already verified credentials need no setup prompt')
    const declinedHome = home('declined')
    const declined = await terminal(declinedHome, 'n', key)
    assert.equal(declined.answered, true)
    assert.equal(declined.submitted, false)
    assert.ok(!existsSync(join(declinedHome, '.flyai', 'config.json')))
    const cancelledHome = home('cancelled')
    const cancelled = await terminal(cancelledHome, 'y', '', { GOTRY_FLYAI_CLI_BIN: verifier })
    assert.equal(cancelled.submitted, true)
    assert.ok(!existsSync(join(cancelledHome, '.flyai', 'config.json')))
    const failedHome = home('verification-failed')
    mkdirSync(join(failedHome, '.flyai'), { mode: 0o700 })
    const prior = JSON.stringify({ FLYAI_API_KEY: 'sk-prior-isolated-key-0000', keep: 'yes' })
    writeFileSync(join(failedHome, '.flyai', 'config.json'), prior, { mode: 0o600 })
    const failed = await terminal(failedHome, 'y', key, { GOTRY_FLYAI_CLI_BIN: verifier, FAKE_FLYAI_RESULT: 'auth-error' })
    assert.equal(failed.submitted, true)
    assert.match(failed.output, /验证未通过/)
    assert.equal(readFileSync(join(failedHome, '.flyai', 'config.json'), 'utf8'), prior, 'failed guided verification must preserve the previous credential')
    assert.doesNotMatch(failed.output, new RegExp(key))
    const ci = await terminal(home('ci-terminal'), 'y', key, { CI: '1' })
    assert.equal(ci.answered, false, 'CI must not prompt even when given a terminal')
    console.log('real terminal guided setup, hidden key, decline/cancel/failure, healthy and CI boundaries: OK')

    const hangingVerifier = join(root, 'hanging-verifier')
    writeFileSync(hangingVerifier, `#!${process.execPath}
require('node:fs').writeFileSync(require('node:path').join(process.env.HOME, 'verifier-pid'), String(process.pid))
setInterval(() => {}, 1000)
`, { mode: 0o700 })
    for (const signal of ['SIGINT', 'SIGTERM']) {
      const interruptedHome = home('interrupted-' + signal)
      mkdirSync(join(interruptedHome, '.flyai'), { mode: 0o700 })
      writeFileSync(join(interruptedHome, '.flyai', 'config.json'), prior, { mode: 0o600 })
      const report = join(pkg, 'gotry-state', 'doctor-report.md')
      const beforeReport = existsSync(report) ? readFileSync(report, 'utf8') : undefined
      let verifierPid
      try {
        const result = await terminal(interruptedHome, 'y', key, { GOTRY_FLYAI_CLI_BIN: hangingVerifier }, signal)
        verifierPid = Number(readFileSync(join(interruptedHome, 'verifier-pid'), 'utf8'))
        assert.equal(result.code, 128 + (signal === 'SIGINT' ? 2 : 15), 'doctor must propagate interrupted setup')
        assert.equal(readFileSync(join(interruptedHome, '.flyai', 'config.json'), 'utf8'), prior)
        assert.equal(existsSync(report) ? readFileSync(report, 'utf8') : undefined, beforeReport, 'interrupted doctor must not continue writing a report')
        assert.throws(() => process.kill(verifierPid, 0), { code: 'ESRCH' })
        assert.doesNotMatch(result.output, new RegExp(key))
      } finally {
        verifierPid ??= existsSync(join(interruptedHome, 'verifier-pid')) ? Number(readFileSync(join(interruptedHome, 'verifier-pid'), 'utf8')) : undefined
        if (verifierPid) { try { process.kill(-verifierPid, 'SIGKILL') } catch { /* already gone */ } }
      }
    }
    console.log('real terminal interrupted doctor preserves credentials/report and exits 130/143: OK')
  }
} finally { rmSync(root, { recursive: true, force: true }) }
