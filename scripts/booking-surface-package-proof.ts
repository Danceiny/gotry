/** Public npm package subpath proof. Run from the repository root with tsx. */
import assert from 'node:assert/strict'
import { spawnSync, type SpawnSyncReturns } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import Ajv2020 from 'ajv/dist/2020.js'
import {
  BOOKING_READ_ACTION_KINDS,
  BOOKING_SURFACE_SCHEMA_VERSION,
} from '@danceiny/gotry/booking-surface'
import { BookingCopilotTaskRuntime } from '@danceiny/gotry/booking-surface/runtime'
import { startBookingCopilotServer } from '@danceiny/gotry/booking-surface/server'
import { createDshEmbeddedBookingPlanner } from '@danceiny/gotry/booking-surface/dsh-planner'
import { startBookingCopilotFromEnvironment } from '@danceiny/gotry/booking-surface/startup'
import { REQUIRED_BENCHMARK_DSH_VERSION } from '../bin/gotry-runtime-resolution.js'
import {
  REQUIRED_DSH_RUNTIME_PACKAGE_COUNT,
  validateDshRuntimeClosure,
} from '../ts/scripts/dsh-runtime-closure.ts'

assert.equal(BOOKING_SURFACE_SCHEMA_VERSION, 'booking.surface')
assert.deepEqual([...BOOKING_READ_ACTION_KINDS].sort(), [
  'checkout.prepare', 'hotel.focus', 'hotel.select', 'offer.check', 'offer.select',
  'offers.compare', 'offers.query', 'offers.view.patch', 'order.observe',
  'results.view.patch', 'search.patch', 'search.run',
].sort(), 'canonical closed 12-action registry')
assert.equal(typeof BookingCopilotTaskRuntime, 'function')
type PublicIssueOperationIntent = Parameters<BookingCopilotTaskRuntime['issueOperation']>[2]
const publicIssueOperationRequiresIntent: undefined extends PublicIssueOperationIntent ? false : true = true
assert.equal(publicIssueOperationRequiresIntent, true, 'public runtime type requires an explicit typed intent')
assert.equal(typeof startBookingCopilotServer, 'function')
assert.equal(typeof createDshEmbeddedBookingPlanner, 'function')
assert.equal(typeof startBookingCopilotFromEnvironment, 'function')

const schemaPath = fileURLToPath(import.meta.resolve('@danceiny/gotry/booking-surface/schema'))
type JsonSchema = { $id?: string; $defs?: Record<string, unknown> }
const schema = JSON.parse(readFileSync(schemaPath, 'utf8')) as JsonSchema
assert.equal(schema.$id, 'https://gotry.dev/schemas/booking.surface.schema.json')
const intentSchemaPath = fileURLToPath(import.meta.resolve('@danceiny/gotry/booking-surface/intent-schema'))
const intentSchema = JSON.parse(readFileSync(intentSchemaPath, 'utf8')) as JsonSchema
assert.equal(intentSchema.$id, 'https://gotry.dev/schemas/booking.intent.schema.json')
assert.doesNotThrow(() => new Ajv2020({ strict: true }).compile(intentSchema), 'intent schema must compile without an external schema registry')
for (const definition of [
  'OpaqueRef', 'NonEmptyString', 'Money', 'StringArrayCriterion', 'BooleanCriterion',
  'StringCriterion', 'MoneyCriterion', 'IntegerCriterion', 'OfferCriteria',
]) {
  assert.deepEqual(intentSchema.$defs?.[definition], schema.$defs?.[definition], `intent schema ${definition} drifted from the canonical surface schema`)
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CLEAN_CONSUMER_INSTALL_TIMEOUT_MS = 300_000
const DIAGNOSTIC_TAIL_BYTES = 256
type Injection = 'nonzero' | 'timeout'
type CommandResult = SpawnSyncReturns<string>

class InstallFailure extends Error {}

function injectionMode(): Injection | undefined {
  const prefix = '--issue488-inject='
  const value = process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length)
  if (value === undefined) return undefined
  if (value === 'nonzero' || value === 'timeout') return value
  throw new Error(`unknown ${prefix}${value}`)
}

function sanitizedTail(value: string | null | undefined): { bytes: number; tail: string } {
  const raw = value ?? ''
  const bytes = Buffer.byteLength(raw)
  const sanitized = raw
    .replace(/https?:\/\/[^\s"'<>]+/gi, '[REDACTED-URL]')
    .replace(/(\b(?:token|password|secret|_authToken|api[_-]?key)\s*[=:]\s*)[^\s,;]+/gi, '$1[REDACTED]')
    .replace(/\bBearer\s+\S+/gi, 'Bearer [REDACTED]')
    .replace(/\b[A-Z][A-Z0-9_]*(?:TOKEN|KEY|SECRET|PASSWORD)[A-Z0-9_]*\s*=\s*\S+/g, '[REDACTED-ENV]')
    .replace(/[\r\n\t\v\f]+/g, ' ')
    .replace(/ {2,}/g, ' ')
    .trim()
  let tail = ''
  let tailBytes = 0
  for (const character of Array.from(sanitized).reverse()) {
    const characterBytes = Buffer.byteLength(character)
    if (tailBytes + characterBytes > DIAGNOSTIC_TAIL_BYTES) break
    tail = character + tail
    tailBytes += characterBytes
  }
  return { bytes, tail }
}

function commandDiagnostic(label: string, elapsedMs: number, result: CommandResult): string {
  const error = result.error as NodeJS.ErrnoException | undefined
  const message = sanitizedTail(error?.message)
  const stdout = sanitizedTail(result.stdout)
  const stderr = sanitizedTail(result.stderr)
  return [
    label,
    `status=${result.status ?? 'null'}`,
    `signal=${result.signal ?? 'null'}`,
    `errorName=${error?.name ?? 'none'}`,
    `errorCode=${error?.code ?? 'none'}`,
    `errorMessage=${JSON.stringify(message.tail)}`,
    `elapsedMs=${elapsedMs}`,
    `stdoutBytes=${stdout.bytes}`,
    `stdoutTail=${JSON.stringify(stdout.tail)}`,
    `stderrBytes=${stderr.bytes}`,
    `stderrTail=${JSON.stringify(stderr.tail)}`,
  ].join(' ')
}

function assertCommandSucceeded(label: string, startedAt: number, result: CommandResult): void {
  assert.equal(result.status, 0, commandDiagnostic(label, Date.now() - startedAt, result))
}

function runInstall(injection: Injection | undefined, tarball: string, cwd: string): CommandResult {
  if (injection === 'nonzero') {
    return spawnSync(process.execPath, ['-e', `
process.stdout.write('https://user:pass@private.invalid/pkg?token=stdout-secret\\n')
process.stderr.write('API_KEY=stderr-secret Bearer bearer-secret\\n')
process.exit(7)
`], { encoding: 'utf8' })
  }
  if (injection === 'timeout') {
    return spawnSync(process.execPath, ['-e', `
process.stdout.write('token=timeout-secret\\n')
setTimeout(() => {}, 5_000)
`], { encoding: 'utf8', timeout: 50 })
  }
  return spawnSync('npm', ['install', '--prefer-online', '--ignore-scripts', '--no-audit', '--no-fund', tarball], {
    cwd,
    encoding: 'utf8',
    timeout: CLEAN_CONSUMER_INSTALL_TIMEOUT_MS,
  })
}

const injection = injectionMode()
let consumerRoot: string | undefined
let tarball: string | undefined
let expectedInjectionFailure: InstallFailure | undefined

try {
  consumerRoot = mkdtempSync(join(tmpdir(), 'gotry-booking-consumer-'))
  const packedConsumer = join(consumerRoot, 'consumer')
  mkdirSync(packedConsumer)
  const consumerScript = join(packedConsumer, 'boot-core.mjs')
  writeFileSync(consumerScript, `
import { createServer } from 'node:http'
import { DeepSeekHarness } from '@deepseek-ai/dsh-sdk-client'
let providerRequests = 0
const server = createServer((req, res) => { req.resume(); req.on('end', () => { providerRequests++; res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end('data: ' + JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', created: 0, model: 'fixture', choices: [{ index: 0, delta: { role: 'assistant', content: 'booted' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }) + '\\n\\ndata: [DONE]\\n\\n') }) })
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
const address = server.address()
const harness = new DeepSeekHarness({ profile: 'sdk-minimal', dshHome: '${consumerRoot}/dsh-home', cwd: '${consumerRoot}', processCwd: '${consumerRoot}', env: { PATH: process.env.PATH, DEEPSEEK_API_KEY: 'fixture', DEEPSEEK_BASE_URL: 'http://127.0.0.1:' + address.port + '/v1' } })
const started = Date.now()
let phase = 'initialize'
const failures = []
function recordFailure(error) {
  const safeNames = ['RequestTimeoutError', 'TransportClosedError', 'SdkProtocolError', 'AggregateError', 'Error']
  failures.push({ phase, elapsedMs: Date.now() - started, providerRequests, error: safeNames.includes(error?.name) ? error.name : 'unknown' })
  process.exitCode = 1
}
try {
  await harness.start()
  phase = 'model_run'
  await harness.run('boot core', { sessionId: 'package-proof-core' })
} catch (error) { recordFailure(error) }
finally {
  phase = 'cleanup'
  try { await harness.close() } catch (error) { recordFailure(error) }
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
}
if (failures.length) console.error('CORE_BOOT_FAILURE', JSON.stringify(failures))
else console.log('PACKED CONSUMER DSH CORE BOOT: OK')
`)

  const packStartedAt = Date.now()
  const tarballResult = spawnSync('npm', ['pack', '--silent', '--ignore-scripts', '--pack-destination', consumerRoot], { cwd: root, encoding: 'utf8' })
  assertCommandSucceeded('npm-pack', packStartedAt, tarballResult)
  const tarballName = tarballResult.stdout.trim()
  assert.ok(tarballName, 'npm pack must report its tarball')
  tarball = resolve(consumerRoot, tarballName)
  const tarballRelative = relative(consumerRoot, tarball)
  assert.ok(tarballRelative && !isAbsolute(tarballRelative) && tarballRelative !== '..' && !tarballRelative.startsWith(`..${sep}`), 'npm pack tarball must remain inside the invocation-owned directory')
  assert.ok(existsSync(tarball), 'npm pack tarball must exist inside the invocation-owned directory')

  writeFileSync(join(packedConsumer, 'package.json'), JSON.stringify({ name: 'clean-consumer', private: true, type: 'module' }))
  const installStartedAt = Date.now()
  const install = runInstall(injection, tarball, packedConsumer)
  if (install.status !== 0) {
    const failure = new InstallFailure(commandDiagnostic('clean-install', Date.now() - installStartedAt, install))
    if (injection) expectedInjectionFailure = failure
    else throw failure
  }

  if (!injection) {
    const installedPackage = JSON.parse(readFileSync(join(packedConsumer, 'node_modules/@danceiny/gotry/package.json'), 'utf8')) as {
      dependencies?: Record<string, string>
    }
    const consumerLock = JSON.parse(readFileSync(join(packedConsumer, 'package-lock.json'), 'utf8')) as {
      packages?: Record<string, { version?: string }>
    }
    const npmClosure = validateDshRuntimeClosure({
      dependencies: installedPackage.dependencies ?? {},
      lockPackages: consumerLock.packages ?? {},
      runtimeVersion: REQUIRED_BENCHMARK_DSH_VERSION,
      expectedPackageCount: REQUIRED_DSH_RUNTIME_PACKAGE_COUNT,
    })
    assert.equal(npmClosure.names.length, REQUIRED_DSH_RUNTIME_PACKAGE_COUNT, 'clean npm consumer must resolve the complete Round 5 DSH closure')
    const consumerRunStartedAt = Date.now()
    const consumerRun = spawnSync(process.execPath, [consumerScript], { cwd: packedConsumer, encoding: 'utf8', timeout: 60_000 })
    assertCommandSucceeded('core-boot', consumerRunStartedAt, consumerRun)
    const sandboxPath = join(packedConsumer, 'node_modules/@deepseek-ai/dsh-sandbox')
    const sandboxBackup = join(consumerRoot, 'dsh-sandbox.backup')
    let sandboxRenamed = false
    try {
      renameSync(sandboxPath, sandboxBackup)
      sandboxRenamed = true
      const faultRun = spawnSync(process.execPath, [consumerScript], { cwd: packedConsumer, encoding: 'utf8', timeout: 60_000 })
      assert.notEqual(faultRun.status, 0, 'removing dsh-sandbox must make the real core proof fail')
    } finally {
      if (sandboxRenamed) renameSync(sandboxBackup, sandboxPath)
    }

    const packReportStartedAt = Date.now()
    const packReport = spawnSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: root, encoding: 'utf8' })
    assertCommandSucceeded('npm-pack-dry-run', packReportStartedAt, packReport)
    const report = JSON.parse(packReport.stdout) as Array<{ files: Array<{ path: string; mode?: number }> }>
    const files = new Map(report[0]!.files.map((entry) => [entry.path, entry]))
    assert.equal(
      [...files.keys()].some((path) => path.endsWith('managed-dsh-worker-fixture.mjs')),
      false,
      'TERM-resistant process fixture must never ship in the runtime package',
    )
    assert.equal(
      [...files.keys()].some((path) => path.endsWith('managed-dsh-pending-worker-fixture.mjs')),
      false,
      'pending-request process fixture must never ship in the runtime package',
    )
    for (const path of [
      'bin/gotry-booking-copilot.js',
      'schemas/booking.intent.schema.json',
      'schemas/booking.surface.schema.json',
      'dist/src/booking-surface/booking-intent.js',
      'ts/src/booking-surface/contracts.ts',
      'dist/src/booking-surface/index.js',
      'dist/src/booking-surface/runtime.js',
      'dist/src/booking-surface/server.js',
      'dist/src/booking-surface/dsh-planner.js',
      'dist/src/booking-surface/dsh-plugin.js',
      'dist/src/booking-surface/dsh-worker.js',
      'dist/src/booking-surface/canonical-schema.js',
      'dist/src/booking-surface/managed-dsh-run-port.js',
      'dist/src/booking-surface/startup.js',
    ]) assert.ok(files.has(path), `npm tarball missing ${path}`)
  }
} finally {
  if (consumerRoot) rmSync(consumerRoot, { recursive: true, force: true })
}

if (injection) {
  assert.ok(expectedInjectionFailure, `injection ${injection} must fail the install subprocess`)
  assert.ok(consumerRoot && !existsSync(consumerRoot), 'injection must clean its owned consumer root')
  assert.ok(tarball && !existsSync(tarball), 'injection must clean its owned tarball')
  const diagnostic = expectedInjectionFailure.message
  for (const field of ['status=', 'signal=', 'errorName=', 'errorCode=', 'errorMessage=', 'elapsedMs=', 'stdoutBytes=', 'stdoutTail=', 'stderrBytes=', 'stderrTail=']) assert.ok(diagnostic.includes(field), `diagnostic missing ${field}`)
  assert.ok(!/stdout-secret|stderr-secret|bearer-secret|timeout-secret|private\.invalid/.test(diagnostic), 'diagnostic must redact injected secrets and URLs')
  if (injection === 'nonzero') assert.ok(diagnostic.includes('status=7'), diagnostic)
  else assert.ok(diagnostic.includes('errorCode=ETIMEDOUT'), diagnostic)
  console.log(`BOOKING SURFACE PACKAGE PROOF: injected ${injection} diagnostics and owned cleanup verified`)
} else {
  console.log('BOOKING SURFACE PACKAGE PROOF: compiled imports/types/schema/npm tarball list resolve')
}
