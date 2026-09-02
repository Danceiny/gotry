/** Public npm package subpath proof. Run from the repository root with tsx. */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
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

assert.equal(BOOKING_SURFACE_SCHEMA_VERSION, 'booking.surface.v1')
assert.deepEqual([...BOOKING_READ_ACTION_KINDS].sort(), [
  'checkout.prepare', 'hotel.focus', 'hotel.select', 'offer.check', 'offer.select',
  'offers.compare', 'offers.query', 'offers.view.patch', 'order.observe',
  'results.view.patch', 'search.patch', 'search.run',
].sort(), 'canonical closed 12-action registry')
assert.equal(typeof BookingCopilotTaskRuntime, 'function')
assert.equal(typeof startBookingCopilotServer, 'function')
assert.equal(typeof createDshEmbeddedBookingPlanner, 'function')
assert.equal(typeof startBookingCopilotFromEnvironment, 'function')

const schemaPath = fileURLToPath(import.meta.resolve('@danceiny/gotry/booking-surface/schema'))
const schema = JSON.parse(readFileSync(schemaPath, 'utf8')) as { $id?: string }
assert.equal(schema.$id, 'https://gotry.dev/schemas/booking.surface.v1.schema.json')

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CLEAN_CONSUMER_INSTALL_TIMEOUT_MS = 300_000
const consumerRoot = mkdtempSync(join(tmpdir(), 'gotry-booking-consumer-'))
const packedConsumer = join(consumerRoot, 'consumer')
mkdirSync(packedConsumer)
const consumerScript = join(packedConsumer, 'boot-core.mjs')
writeFileSync(consumerScript, `
import { createServer } from 'node:http'
import { DeepSeekHarness } from '@deepseek-ai/dsh-sdk-client'
const server = createServer((req, res) => { req.resume(); req.on('end', () => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end('data: ' + JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', created: 0, model: 'fixture', choices: [{ index: 0, delta: { role: 'assistant', content: 'booted' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }) + '\\n\\ndata: [DONE]\\n\\n') }) })
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
const address = server.address()
const harness = new DeepSeekHarness({ profile: 'sdk-minimal', dshHome: '${consumerRoot}/dsh-home', cwd: '${consumerRoot}', processCwd: '${consumerRoot}', env: { PATH: process.env.PATH, DEEPSEEK_API_KEY: 'fixture', DEEPSEEK_BASE_URL: 'http://127.0.0.1:' + address.port + '/v1' } })
try { await harness.run('boot core', { sessionId: 'package-proof-core' }) } finally { await harness.close(); await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())) }
console.log('PACKED CONSUMER DSH CORE BOOT: OK')
`)
const tarballResult = spawnSync('npm', ['pack', '--silent', '--ignore-scripts'], { cwd: root, encoding: 'utf8' })
assert.equal(tarballResult.status, 0, tarballResult.stderr || tarballResult.stdout)
const tarball = resolve(root, tarballResult.stdout.trim())
writeFileSync(join(packedConsumer, 'package.json'), JSON.stringify({ name: 'clean-consumer', private: true, type: 'module' }))
const install = spawnSync('npm', ['install', '--prefer-offline', '--ignore-scripts', '--no-audit', '--no-fund', tarball], {
  cwd: packedConsumer,
  encoding: 'utf8',
  timeout: CLEAN_CONSUMER_INSTALL_TIMEOUT_MS,
})
assert.equal(install.status, 0, install.error?.message || install.stderr || install.stdout)
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
const consumerRun = spawnSync(process.execPath, [consumerScript], { cwd: packedConsumer, encoding: 'utf8', timeout: 60_000 })
assert.equal(consumerRun.status, 0, consumerRun.stderr || consumerRun.stdout)
const sandboxPath = join(packedConsumer, 'node_modules/@deepseek-ai/dsh-sandbox')
const sandboxBackup = join(consumerRoot, 'dsh-sandbox.backup')
renameSync(sandboxPath, sandboxBackup)
try {
  const faultRun = spawnSync(process.execPath, [consumerScript], { cwd: packedConsumer, encoding: 'utf8', timeout: 60_000 })
  assert.notEqual(faultRun.status, 0, 'removing dsh-sandbox must make the real core proof fail')
} finally { renameSync(sandboxBackup, sandboxPath) }
rmSync(tarball, { force: true })
rmSync(consumerRoot, { recursive: true, force: true })

const packReport = spawnSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
  cwd: root,
  encoding: 'utf8',
})
assert.equal(packReport.status, 0, packReport.stderr || packReport.stdout)
const report = JSON.parse(packReport.stdout) as Array<{ files: Array<{ path: string; mode?: number }> }>
const files = new Map(report[0]!.files.map((entry) => [entry.path, entry]))
for (const path of [
  'bin/gotry-booking-copilot.js',
  'schemas/booking.surface.v1.schema.json',
  'ts/src/booking-surface/contracts.ts',
  'dist/src/booking-surface/index.js',
  'dist/src/booking-surface/runtime.js',
  'dist/src/booking-surface/server.js',
  'dist/src/booking-surface/dsh-planner.js',
  'dist/src/booking-surface/dsh-plugin.js',
  'dist/src/booking-surface/canonical-schema.js',
  'dist/src/booking-surface/startup.js',
]) assert.ok(files.has(path), `npm tarball missing ${path}`)

console.log('BOOKING SURFACE PACKAGE PROOF: compiled imports/types/schema/npm tarball list resolve')
