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
import { BOOKING_SURFACE_SCHEMA_VERSION_V2, BOOKING_SURFACE_SCHEMA_V2_SHA256 } from '@danceiny/gotry/booking-surface/contracts-v2'
import { BookingCopilotTaskRuntime } from '@danceiny/gotry/booking-surface/runtime'
import { BookingCopilotTaskRuntimeV2 } from '@danceiny/gotry/booking-surface/runtime-v2'
import { startBookingCopilotServer } from '@danceiny/gotry/booking-surface/server'
import { createDshEmbeddedBookingPlanner, createDshEmbeddedBookingPlannerV2 } from '@danceiny/gotry/booking-surface/dsh-planner'
import { startBookingCopilotFromEnvironment } from '@danceiny/gotry/booking-surface/startup'

assert.equal(BOOKING_SURFACE_SCHEMA_VERSION, 'booking.surface.v1')
assert.deepEqual([...BOOKING_READ_ACTION_KINDS].sort(), [
  'checkout.prepare', 'hotel.focus', 'hotel.select', 'offer.check', 'offer.select',
  'offers.compare', 'offers.query', 'offers.view.patch', 'order.observe',
  'results.view.patch', 'search.patch', 'search.run',
].sort(), 'canonical closed 12-action registry')
assert.equal(typeof BookingCopilotTaskRuntime, 'function')
assert.equal(typeof startBookingCopilotServer, 'function')
assert.equal(typeof createDshEmbeddedBookingPlanner, 'function')
assert.equal(typeof createDshEmbeddedBookingPlannerV2, 'function')
assert.equal(typeof BookingCopilotTaskRuntimeV2, 'function')
assert.equal(BOOKING_SURFACE_SCHEMA_VERSION_V2, 'booking.surface.v2')
assert.equal(BOOKING_SURFACE_SCHEMA_V2_SHA256.length, 64)
assert.equal(typeof startBookingCopilotFromEnvironment, 'function')

const schemaPath = fileURLToPath(import.meta.resolve('@danceiny/gotry/booking-surface/schema'))
const schema = JSON.parse(readFileSync(schemaPath, 'utf8')) as { $id?: string }
assert.equal(schema.$id, 'https://gotry.dev/schemas/booking.surface.v1.schema.json')
const schemaV2Path = fileURLToPath(import.meta.resolve('@danceiny/gotry/booking-surface/schema-v2'))
assert.equal((JSON.parse(readFileSync(schemaV2Path, 'utf8')) as { $id?: string }).$id, 'https://gotry.dev/schemas/booking.surface.v2.schema.json')

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const consumerRoot = mkdtempSync(join(tmpdir(), 'gotry-booking-consumer-'))
const packedConsumer = join(consumerRoot, 'consumer')
mkdirSync(packedConsumer)
const consumerScript = join(packedConsumer, 'boot-core.mjs')
writeFileSync(consumerScript, `
import { createServer } from 'node:http'
import { DeepSeekHarness } from '@deepseek-ai/dsh-sdk-client'
import { BOOKING_SURFACE_SCHEMA_VERSION_V2 } from '@danceiny/gotry/booking-surface/contracts-v2'
import { BookingCopilotTaskRuntimeV2 } from '@danceiny/gotry/booking-surface/runtime-v2'
import { handleBookingCopilotV2Request } from '@danceiny/gotry/booking-surface/server-v2'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
if (BOOKING_SURFACE_SCHEMA_VERSION_V2 !== 'booking.surface.v2' || typeof BookingCopilotTaskRuntimeV2 !== 'function' || typeof handleBookingCopilotV2Request !== 'function') throw new Error('packed v2 exports unavailable')
const packedSchema = JSON.parse(readFileSync(require.resolve('@danceiny/gotry/booking-surface/schema-v2'), 'utf8'))
if (packedSchema.$id !== 'https://gotry.dev/schemas/booking.surface.v2.schema.json') throw new Error('packed v2 schema unavailable')
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
// A clean consumer resolves the packed dependency closure. Keep a bounded
// cold-cache window long enough for the alpha dsh graph, while never allowing
// an install to hang indefinitely.
const install = spawnSync('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', tarball], { cwd: packedConsumer, encoding: 'utf8', timeout: 600_000 })
assert.equal(install.status, 0, install.stderr || install.stdout)
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
// Package inclusion is proved from the actual npm manifest, independently of
// the worktree's Git status.  In particular, the operator-only .worktree.env
// is protected input and must never enter a release tarball.
assert.ok(![...files.keys()].some((path) => path === '.worktree.env' || path.endsWith('/.worktree.env')), 'protected .worktree.env must not be packaged')
for (const path of [
  'bin/gotry-booking-copilot.js',
  'schemas/booking.surface.v1.schema.json',
  'schemas/booking.surface.v2.schema.json',
  'ts/src/booking-surface/contracts.ts',
  'ts/src/booking-surface/contracts-v2.ts',
  'ts/src/booking-surface/validation-v2.ts',
  'ts/src/booking-surface/runtime-v2.ts',
  'ts/src/booking-surface/server-v2.ts',
  'dist/src/booking-surface/index.js',
  'dist/src/booking-surface/runtime.js',
  'dist/src/booking-surface/runtime-v2.js',
  'dist/src/booking-surface/server.js',
  'dist/src/booking-surface/server-v2.js',
  'dist/src/booking-surface/contracts-v2.js',
  'dist/src/booking-surface/validation-v2.js',
  'dist/src/booking-surface/dsh-planner.js',
  'dist/src/booking-surface/dsh-plugin.js',
  'dist/src/booking-surface/canonical-schema.js',
  'dist/src/booking-surface/startup.js',
]) assert.ok(files.has(path), `npm tarball missing ${path}`)

console.log('BOOKING SURFACE PACKAGE PROOF: compiled imports/types/schema/npm tarball list resolve')
