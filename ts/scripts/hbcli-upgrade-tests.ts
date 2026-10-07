/** hbcli dependency baseline and installer upgrade checks. All homes/binaries are isolated. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runDoctorChecks } from '../capabilities/doctor.ts'

const root = mkdtempSync(join(tmpdir(), 'gotry-hbcli-upgrade-test-'))
const home = join(root, 'home')
const bin = join(home, '.local/bin/hbcli')
const credentials = join(home, '.staicli/credentials.json')
const originalCredentials = '{"openapi:uat":{"appKey":"fixture","appSecret":"fixture"},"portal:prod":{"ticket":"preserve"}}'
mkdirSync(join(home, '.local/bin'), { recursive: true })
mkdirSync(join(home, '.staicli'), { recursive: true })
mkdirSync(join(root, 'empty-path'))
writeFileSync(credentials, originalCredentials, { mode: 0o600 })
const writeVersion = (version: string) => writeFileSync(bin,
  `#!/bin/sh\ncase "$*" in\n *version*) echo '${version}';;\n *whoami*) echo '{"api_key":{"configured":true}}';;\nesac\n`, { mode: 0o755 })
const previousPath = process.env.PATH

try {
  process.env.PATH = join(root, 'empty-path')
  writeVersion('0.0.3')
  const old = (await runDoctorChecks({ homeDir: home, repoRoot: root, env: {}, extensionPorts: [] })).items.find(i => i.id === 'hbcli')!
  assert.equal(old.status, 'missing', '0.0.3 must be upgraded even when credentials are configured')
  assert.match(old.detail, /0\.0\.4/)
  assert.match(old.fix ?? '', /staicli-v0\.0\.4\/install\.sh/)
  assert.match(old.fix ?? '', /--version 0\.0\.4/)
  assert.doesNotMatch(old.detail, /会 401/, 'an old dependency version alone does not prove an authentication failure')
  console.log('1. doctor rejects the old baseline and gives the pinned official upgrade')

  const { setupHbcli } = await import(new URL('../../bin/gotry-bootstrap.js', import.meta.url).href)
  let installs = 0
  const install = async (command: string) => {
    installs++
    assert.match(command, /staicli-v0\.0\.4\/install\.sh/)
    assert.match(command, /--version 0\.0\.4/)
    writeVersion('0.0.4')
    return { ok: true }
  }
  assert.equal((await setupHbcli({ homeDir: home, attemptInstall: install })).ok, true)
  assert.equal(installs, 1, 'old binary must enter the installer instead of returning an upgrade hint')
  assert.equal(readFileSync(credentials, 'utf8'), originalCredentials, 'upgrading does not rewrite credentials')
  const current = (await runDoctorChecks({ homeDir: home, repoRoot: root, env: {}, extensionPorts: [] })).items.find(i => i.id === 'hbcli')!
  assert.equal(current.status, 'ok')
  console.log('2. old binary upgrades and is rechecked; existing credentials are preserved')

  assert.equal((await setupHbcli({ homeDir: home, attemptInstall: install })).ok, true)
  writeVersion('0.0.5')
  assert.equal((await setupHbcli({ homeDir: home, attemptInstall: install })).ok, true)
  assert.equal(installs, 1, 'current and newer versions must not be reinstalled or downgraded')
  console.log('3. current/newer binaries remain installed without downgrade')

  writeVersion('0.0.3')
  await setupHbcli({ homeDir: home, checkOnly: true, attemptInstall: install })
  assert.equal(installs, 1, 'check-only cannot run an installer')
  assert.equal((await setupHbcli({ homeDir: home, attemptInstall: async () => ({ ok: false, error: 'fixture failure' }) })).ok, false)
  assert.equal(readFileSync(credentials, 'utf8'), originalCredentials)
  console.log('4. check-only and failed installation preserve the existing configuration')

  assert.equal((await setupHbcli({ homeDir: home, attemptInstall: async () => ({ ok: true }) })).ok, false,
    'installer exit success without the required binary is not a successful upgrade')
  rmSync(bin)
  assert.equal((await setupHbcli({ homeDir: home, attemptInstall: install })).ok, true, 'missing binary uses the same pinned installer')
  assert.equal(installs, 2)
  console.log('5. post-install version is required; missing binary uses the same installer')

  const shadowBin = join(root, 'empty-path/hbcli')
  writeFileSync(shadowBin, '#!/bin/sh\necho 0.0.3\n', { mode: 0o755 })
  const shadowed = await setupHbcli({ homeDir: home, attemptInstall: async () => ({ ok: true }) })
  assert.equal(shadowed.ok, false, 'a newer fallback binary cannot hide an older binary selected by PATH')
  assert.match(shadowed.error ?? '', /PATH/)
  rmSync(shadowBin)
  console.log('5b. PATH precedence is rechecked and shadowing is reported')

  // Optional real release artifact proof: no supplier request and no ambient credentials.
  const binary = process.env.HBCLI_RELEASE_BINARY
  if (binary) {
    const { spawnSync } = await import('node:child_process')
    const digests: Record<string, string> = {
      'darwin-arm64': '0fe14ddeafda8287ac0cd5ab7e1ee88a180c1d46b75c120d2002c7f74f6d5b54',
      'darwin-x64': '6a389403b170a5c68a6d73ad970bc75dfbd69a533d84d5a9a7ab76b4450a70ba',
      'linux-arm64': '8fc87bec736d50ab63488c4c8fef62630ec147ac2ea7a05cc6e12e190bf2182c',
      'linux-x64': '7c3f297e20131bc163a2c0040a8c4e438fc1cbd9179f80f48b81b3a6d4ee0b11',
    }
    assert.equal(createHash('sha256').update(readFileSync(binary)).digest('hex'), digests[`${process.platform}-${process.arch}`],
      'binary must match the official staicli-v0.0.4 release asset digest')
    const releaseHome = join(root, 'release-home')
    mkdirSync(releaseHome)
    const releaseEnv = { HOME: releaseHome, STAICLI_HOME: join(releaseHome, '.staicli'), PATH: previousPath ?? '' }
    const run = (args: string[]) => {
      const r = spawnSync(binary, args, { cwd: releaseHome, env: releaseEnv, encoding: 'utf8', timeout: 10_000 })
      assert.equal(r.error, undefined)
      assert.equal(r.status, 0, `release CLI command failed: ${args.join(' ')}`)
      return r.stdout
    }
    assert.equal(run(['--version']).trim(), '0.0.4')
    const hotelHelp = run(['search', 'hotel-list', '--help'])
    for (const flag of ['--destination-name', '--check-in', '--check-out', '--room-occupancies', '--page-size']) assert.ok(hotelHelp.includes(flag))
    for (const command of ['customer-send-code', 'customer-login', 'register']) assert.ok(run(['auth', '--help']).includes(command))
    run(['--json', '--env', 'uat', 'auth', 'set-credentials', '--app-key', 'fixture', '--app-secret', 'fixture'])
    const stored = JSON.parse(readFileSync(join(releaseEnv.STAICLI_HOME, 'credentials.json'), 'utf8'))
    assert.deepEqual(stored['openapi:uat'], { appKey: 'fixture', appSecret: 'fixture' }, 'GUI credential format matches the release CLI')
    assert.equal(JSON.parse(run(['--json', '--env', 'uat', 'auth', 'whoami'])).api_key.configured, true)
    assert.ok(!existsSync(join(home, '.staicli/versions')), 'real artifact proof stays in its isolated home')
    console.log('6. official release digest/version, hotel flags, auth commands and GUI credential format verified offline')
  } else console.log('6. SKIP real artifact proof: set HBCLI_RELEASE_BINARY to the downloaded official 0.0.4 binary')
} finally {
  process.env.PATH = previousPath
  rmSync(root, { recursive: true, force: true })
}
console.log('HBCLI UPGRADE TESTS: OK')
