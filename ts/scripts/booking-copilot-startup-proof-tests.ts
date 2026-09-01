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
    GOTRY_BOOKING_COPILOT_STATE_ROOT: '/tmp/gotry-booking-startup',
    GOTRY_BOOKING_COPILOT_ARTIFACT_ID: 'not-a-commit',
  }),
  /booking_copilot_artifact_id_invalid/,
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
  GOTRY_BOOKING_COPILOT_ARTIFACT_ID: '1111111111111111111111111111111111111111',
  LLM_API_KEY: 'model-only-key',
  PORTAL_TOKEN: 'must-not-enter-planner',
  HOTELBYTE_TOKEN: 'must-not-enter-planner',
}

const closeOrder: string[] = []
let plannerEnv: Record<string, string | undefined> | undefined
let plannerV2Env: Record<string, string | undefined> | undefined
let serverApiKey = ''
let serverArtifactId = ''
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
  runtimeFactoryV2() { return {} as never },
  async createPlannerV2(options) {
    plannerV2Env = options.env
    return { plannerFactory() { return { async next() { return [] } } }, async close() { closeOrder.push('planner-v2') } }
  },
  async startServer(options) {
    serverApiKey = options.apiKey
    serverArtifactId = options.artifactId ?? ''
    return {
      server: {} as never,
      port: 43123,
      async close() { closeOrder.push('server') },
    }
  },
})

assert.equal(started.port, 43123)
assert.equal(serverApiKey, 'bff-only-key', 'BFF deployment key terminates at the HTTP server')
assert.equal(serverArtifactId, env.GOTRY_BOOKING_COPILOT_ARTIFACT_ID)
assert.equal(plannerEnv?.DEEPSEEK_API_KEY, 'model-only-key')
assert.equal(plannerEnv?.GOTRY_BOOKING_COPILOT_API_KEY, undefined)
assert.equal(plannerEnv?.PORTAL_TOKEN, undefined)
assert.equal(plannerEnv?.HOTELBYTE_TOKEN, undefined)
assert.equal(plannerV2Env?.DEEPSEEK_API_KEY, 'model-only-key')
await started.close()
assert.deepEqual(closeOrder, ['server', 'planner', 'planner-v2', 'ledger'])

rmSync(stateRoot, { recursive: true, force: true })

const v2StateRoot = mkdtempSync(join(tmpdir(), 'gotry-booking-startup-v2-'))
let v2Passed = false
let v2PlannerEnv: Record<string, string | undefined> | undefined
const v2CloseOrder: string[] = []
const v2Started = await startBookingCopilotFromEnvironment({
  ...env,
  GOTRY_BOOKING_COPILOT_STATE_ROOT: v2StateRoot,
}, {
  ensureLedger() { return { close() { v2CloseOrder.push('ledger') } } as never },
  runtimeFactory() { return {} as never },
  createPlanner: async () => ({ plannerFactory() { return { async next() { return [] } } }, async close() {} }),
  runtimeFactoryV2() { return {} as never },
  async createPlannerV2(options) {
    v2PlannerEnv = options.env
    return { plannerFactory() { return { async next() { return [] } } }, async close() { v2CloseOrder.push('planner-v2') } }
  },
  async startServer(options) {
    v2Passed = Boolean(options.v2 && options.runtime && options.plannerFactory)
    return { server: {} as never, port: 43124, async close() { v2CloseOrder.push('server') } }
  },
})
assert.equal(v2Started.port, 43124)
assert.equal(v2Passed, true, 'v2 startup constructs and passes the real v2 adapter seam')
assert.equal(v2PlannerEnv?.DEEPSEEK_API_KEY, 'model-only-key')
await v2Started.close()
assert.deepEqual(v2CloseOrder, ['server', 'planner-v2', 'ledger'])
rmSync(v2StateRoot, { recursive: true, force: true })
console.log('BOOKING COPILOT STARTUP PROOF: env split/server+planner+ledger lifecycle OK')
