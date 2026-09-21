/** Public npm package subpath proof. Run from the repository root with tsx. */
import assert from 'node:assert/strict'
import { spawnSync, type SpawnSyncReturns } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import Ajv2020 from 'ajv/dist/2020.js'
import { HarnessClient } from '@deepseek-ai/dsh-sdk-client'
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

/**
 * Stage records shared by every generated core-boot script. Issue #511's
 * failure exited 1 with zero stdout bytes, so a trailing console call is
 * erased: records go straight to fd 2 as each stage is reached, and the
 * failure record is flushed again from an uncaught-exception hook so an escape
 * out of the script still names the stage that ran out of budget.
 */
const CORE_BOOT_DIAGNOSTIC_HELPERS = `const started = Date.now()
let phase = 'before_initialize'
let providerRequests = 0
const failures = []
let failureFlushed = false
function record(line) { writeSync(2, line + '\\n') }
function mark(next) {
  phase = next
  record('CORE_BOOT_STAGE ' + JSON.stringify({ phase: next, elapsedMs: Date.now() - started, providerRequests }))
}
function recordFailure(error) {
  const safeNames = ['RequestTimeoutError', 'TransportClosedError', 'SdkProtocolError', 'JsonRpcResponseError', 'AggregateError', 'Error']
  const failure = { phase, elapsedMs: Date.now() - started, providerRequests, error: safeNames.includes(error?.name) ? error.name : 'unknown' }
  if (typeof error?.code === 'number') failure.errorCode = error.code
  failures.push(failure)
  process.exitCode = 1
}
function flushFailure() {
  if (failureFlushed || failures.length === 0) return
  failureFlushed = true
  record('CORE_BOOT_FAILURE ' + JSON.stringify(failures.slice(0, 3)))
}
process.on('uncaughtException', (error) => { recordFailure(error); flushFailure(); process.exit(1) })
process.on('exit', flushFailure)`

/** SDK defaults the clean consumer inherits: the initialize deadline plus the shutdown, stdin-EOF and SIGTERM windows. */
const CLEAN_CONSUMER_BOOT_BUDGET_MS = { initialize: 10_000, shutdown: 1_000, eofGrace: 6_000, terminateGrace: 3_000 }

/** A runtime that never answers the handshake and ignores stdin EOF and SIGTERM, so only SIGKILL ends it. */
const UNRESPONSIVE_RUNTIME_SOURCE = `process.on('SIGTERM', () => {})
process.stdin.resume()
process.stderr.write('unresponsive-runtime-fixture\\n')
setInterval(() => {}, 1_000)
`

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

function writeUnresponsiveRuntime(directory: string): string {
  mkdirSync(directory, { recursive: true })
  const fixture = join(directory, 'unresponsive-dsh-runtime.mjs')
  writeFileSync(fixture, UNRESPONSIVE_RUNTIME_SOURCE)
  return fixture
}

/**
 * Measure the boot budget the clean consumer inherits, against an unresponsive
 * runtime: `initialize` burns its whole deadline, then the SDK's own teardown
 * ladder burns the shutdown, stdin-EOF and SIGTERM windows. #511's original
 * failure took 20088ms, which is this composition plus process overhead, so
 * pinning it keeps a future duration self-describing about the stage that ran
 * out of budget.
 */
async function measureCleanConsumerBootBudgets(
  workRoot: string,
): Promise<{ error: string; initializeMs: number; closeMs: number; totalMs: number }> {
  const fixture = writeUnresponsiveRuntime(workRoot)
  const client = new HarnessClient({
    profile: 'sdk-minimal',
    dshBin: fixture,
    dshHome: join(workRoot, 'budget-home'),
    cwd: workRoot,
    processCwd: workRoot,
    env: { PATH: process.env.PATH },
  })
  const totalStartedAt = Date.now()
  client.start()
  const initializeStartedAt = Date.now()
  let error = 'none'
  try {
    await client.initialize({ cwd: workRoot, provider: 'deepseek-official', model: 'deepseek-v4-flash' })
  } catch (cause) {
    error = cause instanceof Error ? cause.name : 'unknown'
  }
  const initializeMs = Date.now() - initializeStartedAt
  const closeStartedAt = Date.now()
  await client.close()
  return { error, initializeMs, closeMs: Date.now() - closeStartedAt, totalMs: Date.now() - totalStartedAt }
}

/**
 * Negative control for the shape #511 could not diagnose: a core-boot script
 * with no catch exits 1 with zero stdout bytes, which is how the original
 * failure erased its own diagnostics. The stage record must survive it.
 */
function runUncaughtEscapeControl(workRoot: string): { result: CommandResult; elapsedMs: number } {
  const directory = join(workRoot, 'escape-consumer')
  const fixture = writeUnresponsiveRuntime(join(workRoot, 'escape-runtime'))
  mkdirSync(join(directory, 'node_modules'), { recursive: true })
  // The generated script lives outside this checkout, so give it the same
  // scoped dependency tree a packed consumer would have installed.
  symlinkSync(resolve(root, 'node_modules/@deepseek-ai'), join(directory, 'node_modules/@deepseek-ai'), 'junction')
  const script = join(directory, 'boot-core-escape.mjs')
  writeFileSync(script, `
import { writeSync } from 'node:fs'
import { DeepSeekHarness } from '@deepseek-ai/dsh-sdk-client'
${CORE_BOOT_DIAGNOSTIC_HELPERS}
const harness = new DeepSeekHarness({ profile: 'sdk-minimal', dshBin: ${JSON.stringify(fixture)}, dshHome: ${JSON.stringify(join(workRoot, 'escape-home'))}, cwd: ${JSON.stringify(directory)}, processCwd: ${JSON.stringify(directory)}, env: { PATH: process.env.PATH }, initializeTimeoutMs: 300, shutdownTimeoutMs: 100, disposeEofGraceMs: 400, disposeGraceMs: 300 })
mark('before_initialize')
await harness.start()
mark('initialized')
await harness.run('boot core', { sessionId: 'package-proof-escape' })
flushFailure()
`)
  const startedAt = Date.now()
  return {
    result: spawnSync(process.execPath, [script], { cwd: directory, encoding: 'utf8', timeout: 30_000 }),
    elapsedMs: Date.now() - startedAt,
  }
}

/**
 * Control for the closed error class: the SDK surfaces every JSON-RPC error
 * response as `JsonRpcResponseError`, so an allowlist that omits it drops the
 * only distinguishing bit and reports `unknown`. The record must name the class
 * and keep the numeric wire code, which separates same-class protocol errors.
 */
function runJsonRpcErrorClassificationControl(workRoot: string): { result: CommandResult; elapsedMs: number } {
  const directory = join(workRoot, 'jsonrpc-error-consumer')
  mkdirSync(join(directory, 'node_modules'), { recursive: true })
  symlinkSync(resolve(root, 'node_modules/@deepseek-ai'), join(directory, 'node_modules/@deepseek-ai'), 'junction')
  const script = join(directory, 'boot-core-jsonrpc-error.mjs')
  writeFileSync(script, `
import { writeSync } from 'node:fs'
import { JsonRpcResponseError } from '@deepseek-ai/dsh-sdk-client'
${CORE_BOOT_DIAGNOSTIC_HELPERS}
mark('before_initialize')
throw new JsonRpcResponseError(-32603, 'session unavailable')
`)
  const startedAt = Date.now()
  return {
    result: spawnSync(process.execPath, [script], { cwd: directory, encoding: 'utf8', timeout: 30_000 }),
    elapsedMs: Date.now() - startedAt,
  }
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
import { writeSync } from 'node:fs'
import { DeepSeekHarness } from '@deepseek-ai/dsh-sdk-client'
${CORE_BOOT_DIAGNOSTIC_HELPERS}
const server = createServer((req, res) => { req.resume(); req.on('end', () => { providerRequests++; res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end('data: ' + JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', created: 0, model: 'fixture', choices: [{ index: 0, delta: { role: 'assistant', content: 'booted' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }) + '\\n\\ndata: [DONE]\\n\\n') }) })
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
const address = server.address()
const harness = new DeepSeekHarness({ profile: 'sdk-minimal', dshHome: '${consumerRoot}/dsh-home', cwd: '${consumerRoot}', processCwd: '${consumerRoot}', env: { PATH: process.env.PATH, DEEPSEEK_API_KEY: 'fixture', DEEPSEEK_BASE_URL: 'http://127.0.0.1:' + address.port + '/v1' } })
mark('before_initialize')
try {
  await harness.start()
  mark('initialized')
  await harness.run('boot core', { sessionId: 'package-proof-core' })
  mark('model_run_done')
} catch (error) { recordFailure(error) }
finally {
  mark('cleanup')
  try { await harness.close() } catch (error) { recordFailure(error) }
  try { await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())) } catch (error) { recordFailure(error) }
  mark('cleanup_done')
}
flushFailure()
if (failures.length === 0) console.log('PACKED CONSUMER DSH CORE BOOT: OK')
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
    const bootStages = (consumerRun.stderr ?? '')
      .split('\n')
      .filter((line) => line.startsWith('CORE_BOOT_STAGE '))
      .map((line) => JSON.parse(line.slice('CORE_BOOT_STAGE '.length)) as { phase: string; elapsedMs: number; providerRequests: number })
    assert.ok(
      bootStages.some((stage) => stage.phase === 'initialized'),
      `clean consumer must report the stage trace that names a cold-boot stall: ${sanitizedTail(consumerRun.stderr).tail}`,
    )
    console.log(
      `BOOKING SURFACE PACKAGE PROOF: clean-consumer boot budget ${CLEAN_CONSUMER_BOOT_BUDGET_MS.initialize}ms ${JSON.stringify(bootStages.map((stage) => [stage.phase, stage.elapsedMs]))} modelRequests=${bootStages.at(-1)?.providerRequests ?? 0}`,
    )
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

if (!injection) {
  const budgetRoot = mkdtempSync(join(tmpdir(), 'gotry-booking-boot-budget-'))
  try {
    const teardownBudget =
      CLEAN_CONSUMER_BOOT_BUDGET_MS.shutdown + CLEAN_CONSUMER_BOOT_BUDGET_MS.eofGrace + CLEAN_CONSUMER_BOOT_BUDGET_MS.terminateGrace
    const budgets = await measureCleanConsumerBootBudgets(budgetRoot)
    assert.equal(
      budgets.error,
      'RequestTimeoutError',
      `an unresponsive runtime must fail the handshake with a typed timeout: ${JSON.stringify(budgets)}`,
    )
    assert.ok(
      budgets.initializeMs >= CLEAN_CONSUMER_BOOT_BUDGET_MS.initialize && budgets.initializeMs < CLEAN_CONSUMER_BOOT_BUDGET_MS.initialize + 5_000,
      `initialize must burn its whole ${CLEAN_CONSUMER_BOOT_BUDGET_MS.initialize}ms deadline, got ${budgets.initializeMs}ms`,
    )
    assert.ok(
      budgets.closeMs >= teardownBudget - 2_000 && budgets.closeMs < teardownBudget + 5_000,
      `teardown must burn the ${CLEAN_CONSUMER_BOOT_BUDGET_MS.shutdown}+${CLEAN_CONSUMER_BOOT_BUDGET_MS.eofGrace}+${CLEAN_CONSUMER_BOOT_BUDGET_MS.terminateGrace}ms windows, got ${budgets.closeMs}ms`,
    )
    assert.ok(
      budgets.totalMs >= 19_000 && budgets.totalMs < budgets.initializeMs + budgets.closeMs + 1_500,
      `the 20088ms failure shape is this composition with no unexplained segment: ${JSON.stringify(budgets)}`,
    )
    console.log(`BOOKING SURFACE PACKAGE PROOF: unresponsive-runtime boot ${JSON.stringify(budgets)}`)

    const escape = runUncaughtEscapeControl(budgetRoot)
    assert.equal(escape.result.status, 1, commandDiagnostic('uncaught-escape-control', escape.elapsedMs, escape.result))
    assert.equal(escape.result.stdout, '', 'the undiagnosed failure shape writes zero stdout bytes')
    const recordLine = (escape.result.stderr ?? '').split('\n').find((line) => line.startsWith('CORE_BOOT_FAILURE '))
    assert.ok(recordLine, `the stage record must survive an uncaught escape: ${sanitizedTail(escape.result.stderr).tail}`)
    const [record] = JSON.parse(recordLine.slice('CORE_BOOT_FAILURE '.length)) as Array<{ phase: string; error: string; providerRequests: number }>
    assert.equal(record?.phase, 'before_initialize', 'the record names the stage that ran out of budget')
    assert.equal(record?.error, 'RequestTimeoutError', 'the record classifies the SDK timeout')
    assert.equal(record?.providerRequests, 0, 'a failed handshake reaches no provider request')
    console.log(`BOOKING SURFACE PACKAGE PROOF: uncaught-escape control ${JSON.stringify({ status: escape.result.status, stdoutBytes: 0, record })}`)

    const classification = runJsonRpcErrorClassificationControl(budgetRoot)
    assert.equal(
      classification.result.status,
      1,
      commandDiagnostic('jsonrpc-error-classification', classification.elapsedMs, classification.result),
    )
    const classificationLine = (classification.result.stderr ?? '')
      .split('\n')
      .find((line) => line.startsWith('CORE_BOOT_FAILURE '))
    assert.ok(classificationLine, `the classification record must survive: ${sanitizedTail(classification.result.stderr).tail}`)
    const [classified] = JSON.parse(classificationLine.slice('CORE_BOOT_FAILURE '.length)) as Array<{
      phase: string
      error: string
      errorCode?: number
      providerRequests: number
    }>
    assert.equal(classified?.error, 'JsonRpcResponseError', 'a JSON-RPC error response must keep its own class rather than degrade to unknown')
    assert.equal(classified?.errorCode, -32603, 'the numeric wire code separates same-class protocol errors')
    assert.equal(classified?.providerRequests, 0, 'a protocol error response reaches no provider request')
    console.log(
      `BOOKING SURFACE PACKAGE PROOF: jsonrpc-error classification ${JSON.stringify({ status: classification.result.status, record: classified })}`,
    )
  } finally {
    rmSync(budgetRoot, { recursive: true, force: true })
  }
}
