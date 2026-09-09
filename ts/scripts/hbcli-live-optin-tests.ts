/**
 * Offline supplier opt-in gate proof for issue #318.
 *
 * Spawn the real hbcli-e2e entrypoint with a discoverable fixture binary and
 * a blocked-network/read-write trap. The default entrypoint must return before
 * any probe, so the fixture and traps must all remain untouched.
 *
 * This test never enables GOTRY_HBCLI_LIVE and never calls a supplier endpoint.
 */

import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

const root = join(import.meta.dirname, '..', '..')
const e2e = join(root, 'ts', 'scripts', 'hbcli-e2e-tests.ts')
const fixtureRoot = await mkdtemp(join(tmpdir(), 'gotry-issue-318-'))
const fixtureHome = join(fixtureRoot, 'home')
const fixtureBin = join(fixtureHome, '.local', 'bin', 'hbcli')
const counters = join(fixtureRoot, 'counters')
const launchCounter = join(counters, 'binary-launches')
const networkCounter = join(counters, 'network-attempts')
const credentialCounter = join(counters, 'credential-reads-writes')
const trap = join(fixtureRoot, 'blocked-network-and-credential-trap.mjs')

await mkdir(dirname(fixtureBin), { recursive: true })
await mkdir(counters, { recursive: true })
await writeFile(fixtureBin, `#!/bin/sh
printf '1\\n' >> "$HBCLI_LAUNCH_COUNTER"
printf 'fixture hbcli must not be started in offline mode\\n' >&2
exit 97
`)
await chmod(fixtureBin, 0o755)
await writeFile(trap, `import fs from 'node:fs'
import { appendFileSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'

const networkCounter = ${JSON.stringify(networkCounter)}
const credentialCounter = ${JSON.stringify(credentialCounter)}
const credentialRoot = ${JSON.stringify(fixtureHome)}
const realFetch = globalThis.fetch
globalThis.fetch = async (...args) => {
  appendFileSync(networkCounter, JSON.stringify(args[0]) + '\\n')
  throw new Error('blocked network in issue #318 proof')
}
const isCredentialPath = (value) => String(value).startsWith(credentialRoot + '/.staicli')
const realReadFileSync = fs.readFileSync
fs.readFileSync = function (path, ...args) {
  if (isCredentialPath(path)) appendFileSync(credentialCounter, 'read\\n')
  return realReadFileSync.call(this, path, ...args)
}
const realWriteFileSync = fs.writeFileSync
fs.writeFileSync = function (path, ...args) {
  if (isCredentialPath(path)) appendFileSync(credentialCounter, 'write\\n')
  return realWriteFileSync.call(this, path, ...args)
}
syncBuiltinESMExports()
void realFetch
`)

try {
  for (const optIn of [undefined, '0', 'true', 'yes'] as const) {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: fixtureHome,
      PATH: `${dirname(fixtureBin)}:${process.env.PATH ?? ''}`,
      NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import=${trap}`.trim(),
      HBCLI_LAUNCH_COUNTER: launchCounter,
      STAICLI_HOME: join(fixtureHome, '.staicli'),
    }
    if (optIn === undefined) delete env.GOTRY_HBCLI_LIVE
    else env.GOTRY_HBCLI_LIVE = optIn
    const result = spawnSync('npx', ['--no-install', 'tsx', e2e], {
      cwd: join(root, 'ts'), encoding: 'utf8', env,
    })
    assert.equal(result.status, 0, `offline entrypoint should exit 0 for ${String(optIn)}, stderr=${result.stderr}`)
    assert.match(result.stdout, /SKIP: HotelByte UAT 已关闭/)
    assert.match(result.stdout, /未探测 hbcli\/网络\/凭证/)
  }
  for (const [path, label] of [
    [launchCounter, 'fixture binary launches'],
    [networkCounter, 'network attempts'],
    [credentialCounter, 'credential reads/writes'],
  ] as const) {
    let observed = ''
    try { observed = await readFile(path, 'utf8') } catch { /* absent means zero */ }
    assert.equal(observed, '', `${label} must remain zero, observed=${observed}`)
  }
  console.log('HBCLI LIVE OPT-IN PROOF: real entrypoint + discoverable fixture + blocked network; unset/0/invalid => binary=0/network=0/credential=0')
} finally {
  await rm(fixtureRoot, { recursive: true, force: true })
}
