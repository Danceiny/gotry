/**
 * #232 staicli release contract (test-only):
 *   - verify a caller-supplied local npm tarball against the recorded bytes;
 *   - inspect and execute the actual packaged hbcli entrypoint's safe help surface;
 *   - prove the unsupported tenant selector is rejected by the actual parser;
 *   - reject a one-byte tampered artifact before extraction/execution.
 *
 * This script never downloads, runs npm lifecycle scripts, reads credentials, or
 * calls HotelByte/supplier endpoints. It does not classify supplier outcomes;
 * those require recorded supplier response fixtures and the runtime adapter
 * remains outside this preparation slice.
 *
 * Usage:
 *   cd ts && npx tsx scripts/hbcli-release-contract-tests.ts /path/to/staicli-0.0.3.tgz
 *   STAICLI_TARBALL=/path/to/staicli-0.0.3.tgz npx tsx scripts/hbcli-release-contract-tests.ts
 */

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

interface ReleaseManifest {
  schema_version: string
  artifact: {
    registry_tarball: string
    filename: string
    integrity: string
    sha256: string
    package: {
      name: string
      version: string
      main: string
      bin: Record<string, string>
    }
  }
  safe_help: Record<string, {
    argv: string[]
    exit_code: number
    stdout_sha256: string
    stderr_sha256: string
    required_lines: string[]
  }>
  unsupported_selector: {
    argv: string[]
    exit_code: number
    stderr_sha256: string
    stderr_contains: string
  }
}

const manifestPath = resolve(dirname(new URL(import.meta.url).pathname), '..', 'fixtures', 'staicli-0.0.3.release-contract.json')
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as ReleaseManifest
const tarballPath = process.argv[2] ?? process.env.STAICLI_TARBALL

if (!tarballPath) {
  console.log('SKIP: no local staicli tarball supplied; pass argv[2] or STAICLI_TARBALL for artifact-byte verification')
  process.exit(0)
}

assert.equal(manifest.schema_version, 'gotry_staicli_release_contract.v1')
assert.ok(existsSync(tarballPath), `tarball must exist: ${tarballPath}`)

function digest(algorithm: 'sha256' | 'sha512', bytes: Buffer): string {
  return createHash(algorithm).update(bytes).digest(algorithm === 'sha512' ? 'base64' : 'hex')
}

function sha256Text(text: string): string {
  return digest('sha256', Buffer.from(text))
}

function verifyTarball(path: string): Buffer {
  const bytes = readFileSync(path)
  const actualIntegrity = `sha512-${digest('sha512', bytes)}`
  assert.equal(actualIntegrity, manifest.artifact.integrity, 'tarball bytes must match the recorded npm integrity')
  assert.equal(digest('sha256', bytes), manifest.artifact.sha256, 'tarball bytes must match the recorded SHA-256')
  return bytes
}

function runNode(entry: string, argv: string[], home: string): { status: number | null; stdout: string; stderr: string } {
  mkdirSync(home, { recursive: true })
  const result = spawnSync(process.execPath, [entry, ...argv], {
    cwd: home,
    env: {
      HOME: home,
      STAICLI_HOME: join(home, 'staicli'),
      PATH: process.env.PATH ?? '',
    },
    encoding: 'utf8',
  })
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

function assertRecordedCommand(name: string, entry: string, command: { argv: string[]; exit_code: number; stdout_sha256: string; stderr_sha256: string; required_lines: string[] }, home: string): void {
  const result = runNode(entry, command.argv, home)
  assert.equal(result.status, command.exit_code, `${name} exit code must match recorded artifact evidence`)
  assert.equal(sha256Text(result.stdout), command.stdout_sha256, `${name} stdout must match recorded artifact evidence`)
  assert.equal(sha256Text(result.stderr), command.stderr_sha256, `${name} stderr must match recorded artifact evidence`)
  for (const line of command.required_lines) assert.ok(result.stdout.includes(line), `${name} help must contain: ${line}`)
}

const workspace = mkdtempSync(join(tmpdir(), 'gotry-staicli-contract-'))
const unpacked = join(workspace, 'unpacked')
const tamperedPath = join(workspace, 'tampered.tgz')
const isolatedHome = join(workspace, 'home')
const extractedPackage = join(unpacked, 'package')
mkdirSync(unpacked)

try {
  // 1. The recorded integrity is checked against the actual supplied tarball bytes.
  const originalBytes = verifyTarball(tarballPath)
  console.log(`1. tarball bytes verified (${manifest.artifact.package.name}@${manifest.artifact.package.version}, ${manifest.artifact.integrity})`)

  // 2. A one-byte corruption must fail the same verification before execution.
  const corrupted = Buffer.from(originalBytes)
  corrupted[corrupted.length - 1] ^= 1
  writeFileSync(tamperedPath, corrupted)
  assert.throws(() => verifyTarball(tamperedPath), /tarball bytes must match the recorded npm integrity/)
  console.log('2. one-byte tarball corruption rejected by integrity verification')

  // 3. Extract with tar only; npm is not invoked, and package scripts cannot run.
  const extraction = spawnSync('tar', ['-xzf', tarballPath, '-C', unpacked], { encoding: 'utf8' })
  assert.equal(extraction.status, 0, `tar extraction failed: ${extraction.stderr ?? ''}`)
  const packageJson = JSON.parse(readFileSync(join(extractedPackage, 'package.json'), 'utf8')) as { name: string; version: string; main: string; bin: Record<string, string> }
  assert.equal(packageJson.name, manifest.artifact.package.name)
  assert.equal(packageJson.version, manifest.artifact.package.version)
  assert.equal(packageJson.main, manifest.artifact.package.main)
  assert.deepEqual(packageJson.bin, manifest.artifact.package.bin)
  const entry = join(extractedPackage, packageJson.bin.hbcli)
  assert.ok(existsSync(entry), `recorded hbcli bin must exist: ${entry}`)
  console.log(`3. packaged identity/bin verified (${packageJson.name}@${packageJson.version} -> ${packageJson.bin.hbcli})`)

  // 4. Execute only safe help commands with a fresh HOME and STAICLI_HOME.
  for (const [name, command] of Object.entries(manifest.safe_help)) {
    assertRecordedCommand(name, entry, command, join(isolatedHome, name))
    console.log(`4.${name}. actual packaged help surface verified (exit ${command.exit_code})`)
  }

  // 5. The actual Commander parser, not a copied schema, rejects the unsupported selector.
  const selector = runNode(entry, manifest.unsupported_selector.argv, join(isolatedHome, 'selector'))
  assert.equal(selector.status, manifest.unsupported_selector.exit_code)
  assert.equal(sha256Text(selector.stderr), manifest.unsupported_selector.stderr_sha256)
  assert.ok(selector.stderr.includes(manifest.unsupported_selector.stderr_contains))
  assert.equal(selector.stdout, '')
  console.log('5. actual parser rejects --tenant-entity-id without entering a supplier action')
} finally {
  rmSync(workspace, { recursive: true, force: true })
}

console.log('HBCLI RELEASE CONTRACT TESTS: 5/5 OK (artifact bytes/help/parser/tamper; no supplier or credential access)')
