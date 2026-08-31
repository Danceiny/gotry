/** Public npm package subpath proof. Run from the repository root with tsx. */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  BOOKING_READ_ACTION_KINDS,
  BOOKING_SURFACE_SCHEMA_VERSION,
} from '@danceiny/gotry/booking-surface'
import { BookingCopilotTaskRuntime } from '@danceiny/gotry/booking-surface/runtime'
import { startBookingCopilotServer } from '@danceiny/gotry/booking-surface/server'
import { createDshEmbeddedBookingPlanner } from '@danceiny/gotry/booking-surface/dsh-planner'
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
assert.equal(typeof startBookingCopilotFromEnvironment, 'function')

const schemaPath = fileURLToPath(import.meta.resolve('@danceiny/gotry/booking-surface/schema'))
const schema = JSON.parse(readFileSync(schemaPath, 'utf8')) as { $id?: string }
assert.equal(schema.$id, 'https://gotry.dev/schemas/booking.surface.v1.schema.json')

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const packed = spawnSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
  cwd: root,
  encoding: 'utf8',
})
assert.equal(packed.status, 0, packed.stderr || packed.stdout)
const report = JSON.parse(packed.stdout) as Array<{ files: Array<{ path: string; mode?: number }> }>
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
