/** Production startup composition proof (dependencies injected; no real model). */

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  resolveBookingCopilotStartupConfig,
  startBookingCopilotFromEnvironment,
} from '../src/booking-surface/startup.ts'

assert.throws(
  () => resolveBookingCopilotStartupConfig({}),
  /booking_copilot_api_key_required/,
)
assert.throws(
  () => resolveBookingCopilotStartupConfig({
    GOTRY_BOOKING_COPILOT_API_KEY: 'bff-key',
    GOTRY_BOOKING_COPILOT_STATE_ROOT: 'relative/state',
  }),
  /booking_copilot_state_root_must_be_absolute/,
)

const stateRoot = mkdtempSync(join(tmpdir(), 'gotry-booking-startup-'))
const env = {
  GOTRY_BOOKING_COPILOT_API_KEY: 'bff-only-key',
  GOTRY_BOOKING_COPILOT_STATE_ROOT: stateRoot,
  GOTRY_BOOKING_COPILOT_PORT: '0',
  LLM_API_KEY: 'model-only-key',
  PORTAL_TOKEN: 'must-not-enter-planner',
  HOTELBYTE_TOKEN: 'must-not-enter-planner',
}

const closeOrder: string[] = []
let plannerEnv: Record<string, string | undefined> | undefined
let serverApiKey = ''
const fakeLedger = { close() { closeOrder.push('ledger') } }
const started = await startBookingCopilotFromEnvironment(env, {
  ensureLedger() { return fakeLedger as never },
  runtimeFactory() { return {} as never },
  async createPlanner(options) {
    plannerEnv = options.env
    return {
      plannerFactory() { return { async next() { return [] } } },
      async close() { closeOrder.push('planner') },
    }
  },
  async startServer(options) {
    serverApiKey = options.apiKey
    return {
      server: {} as never,
      port: 43123,
      async close() { closeOrder.push('server') },
    }
  },
})

assert.equal(started.port, 43123)
assert.equal(serverApiKey, 'bff-only-key', 'BFF deployment key terminates at the HTTP server')
assert.equal(plannerEnv?.DEEPSEEK_API_KEY, 'model-only-key')
assert.equal(plannerEnv?.GOTRY_BOOKING_COPILOT_API_KEY, undefined)
assert.equal(plannerEnv?.PORTAL_TOKEN, undefined)
assert.equal(plannerEnv?.HOTELBYTE_TOKEN, undefined)
await started.close()
assert.deepEqual(closeOrder, ['server', 'planner', 'ledger'])

rmSync(stateRoot, { recursive: true, force: true })
console.log('BOOKING COPILOT STARTUP PROOF: env split/server+planner+ledger lifecycle OK')
