/** Production startup composition proof (dependencies injected; no real model). */

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  resolveBookingCopilotStartupConfig,
  startBookingCopilotFromEnvironment,
} from '../src/booking-surface/startup.ts'
import { BOOKING_READ_ACTION_KINDS } from '../src/booking-surface/contracts.ts'

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

await assert.rejects(
  startBookingCopilotFromEnvironment({ ...env, GOTRY_BOOKING_COPILOT_INGRESS_MODE: 'bff-ingress-binding' }, {} as never),
  /booking_copilot_ingress_binding_required/,
  'explicit ingress mode rejects startup when the trusted BFF seam is absent',
)
await assert.rejects(
  startBookingCopilotFromEnvironment(env, {
    ingressBinding: { bind: () => ({ taskId: 'partial-task', turnId: 'partial-turn', contextRef: 'partial-context', surface: 'tenant', allowedActions: [...BOOKING_READ_ACTION_KINDS] }) },
  } as never),
  /booking_copilot_ingress_binding_pair_required/,
  'partial trusted BFF seam is rejected before startup',
)
await assert.rejects(
  startBookingCopilotFromEnvironment(env, { principal: { subject: 'partial-bff', scope: 'booking:read' } } as never),
  /booking_copilot_ingress_binding_pair_required/,
  'principal without a binding is rejected before startup',
)

let standaloneIngressMode = ''
const standaloneStateRoot = mkdtempSync(join(tmpdir(), 'gotry-booking-startup-standalone-'))
const standalone = await startBookingCopilotFromEnvironment({ ...env, GOTRY_BOOKING_COPILOT_STATE_ROOT: standaloneStateRoot }, {
  ensureLedger() { return { close() {} } as never },
  runtimeFactory() { return {} as never },
  createPlanner: async () => ({ plannerFactory() { return { async next() { return [] } } }, async close() {} }),
  async startServer(options) {
    standaloneIngressMode = options.ingressMode ?? ''
    return { server: {} as never, port: 43122, async close() {} }
  },
})
assert.equal(standalone.port, 43122)
assert.equal(standaloneIngressMode, 'bff-bound-turn-only', 'standalone production startup uses the explicit bound-turn-only mode')
await standalone.close()
rmSync(standaloneStateRoot, { recursive: true, force: true })

const closeOrder: string[] = []
let plannerEnv: Record<string, string | undefined> | undefined
let serverApiKey = ''
let serverArtifactId = ''
const trustedEnv = { ...env, GOTRY_BOOKING_COPILOT_INGRESS_MODE: 'bff-ingress-binding' }
const fakeLedger = { close() { closeOrder.push('ledger') } }
const trustedBinding = { bind: () => ({ taskId: 'startup-task', turnId: 'startup-turn', contextRef: 'startup-context', surface: 'tenant' as const, allowedActions: [...BOOKING_READ_ACTION_KINDS] }) }
const started = await startBookingCopilotFromEnvironment(trustedEnv, {
  ensureLedger() { return fakeLedger as never },
  runtimeFactory() { return {} as never },
  async createPlanner(options) {
    plannerEnv = options.env
    return {
      plannerFactory() { return { async next() { return [] } } },
      async close() { closeOrder.push('planner') },
    }
  },
  ingressBinding: trustedBinding,
  principal: { subject: 'startup-bff', scope: 'booking:read' },
  async startServer(options) {
    serverApiKey = options.apiKey
    serverArtifactId = options.artifactId ?? ''
    assert.equal(options.ingressMode, 'bff-ingress-binding')
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
await started.close()
assert.deepEqual(closeOrder, ['server', 'planner', 'ledger'])

rmSync(stateRoot, { recursive: true, force: true })
console.log('BOOKING COPILOT STARTUP PROOF: env split/server+planner+ledger lifecycle OK')
