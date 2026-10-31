/**
 * Quotas and metering per tenant and per organization (AaaS A2, docs/rfc/aaas-rfc.md §4.4; threats S-10 and S-11).
 *
 * Offline and deterministic: the clock is a number the suite moves by hand, the price table is the real frozen
 * `data/llm-price-table.json` (ADR-20), and nothing touches a state root or the network.
 *
 *   P  policy: invalid limits and an unpriced model are refused at construction
 *   C  concurrency: tenant, organization and global caps, release, the narrowest scope refuses first
 *   R  rates: turn rate and bridge job rate in rolling windows, with an exact retry hint
 *   L  LLM budget: measured usage priced by the frozen table, fail closed on an unpriced model, the worst-case charge
 *   S  ledger size: per tenant and per organization
 *   I  isolation: a hot tenant is refused alone, a refusal reserves nothing, counters hold no personal data
 *
 * Run: cd ts && npx tsx scripts/tenant-seam-quota-tests.ts
 */

import assert from 'node:assert/strict'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { loadPriceTable } from '../src/llm-price-table.ts'
import {
  DEFAULT_QUOTA_POLICY,
  deriveSeamTenant,
  QuotaExceededError,
  SeamTenantRequiredError,
  StaticOrganizationKeyring,
  TenantQuotas,
  type QuotaPolicy,
  type SeamTenant,
} from '../src/tenant-seam/index.ts'
import { InvalidTenantIdError, TenantStateError } from '../src/tenant-state/errors.ts'

const TS_ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..')
const TABLE = loadPriceTable(join(TS_ROOT, 'data', 'llm-price-table.json'))
const MODEL = 'deepseek-v4-flash'
const KEYRING = new StaticOrganizationKeyring({ acme: Buffer.alloc(32, 7), globex: Buffer.alloc(32, 9) })

let passed = 0
function check(label: string, assertion: () => void): void {
  assertion()
  passed += 1
  console.log(`  ok - ${label}`)
}

function tenantOf(organization: string, subject: string): SeamTenant {
  return deriveSeamTenant({ organization, issuer: `https://idp.example/${organization}`, subject, scope: 'booking:read' }, KEYRING)
}

const POLICY: QuotaPolicy = {
  tenant: {
    concurrentTurns: 2,
    turns: { limit: 3, windowMs: 1_000 },
    llm: { tokens: 1_000_000, costUsd: 0.5, windowMs: 10_000 },
    bridgeJobs: { limit: 2, windowMs: 1_000 },
    ledgerBytes: 1_000,
  },
  organization: {
    concurrentTurns: 3,
    turns: { limit: 5, windowMs: 1_000 },
    llm: { tokens: 2_000_000, costUsd: 1, windowMs: 10_000 },
    bridgeJobs: { limit: 3, windowMs: 1_000 },
    ledgerBytes: 1_500,
  },
  globalConcurrentTurns: 4,
  unprovenInvocation: { tokens: 10_000, costUsd: 0.05 },
}

let now = 0
function quotas(policy: QuotaPolicy = POLICY): TenantQuotas {
  now = 0
  return new TenantQuotas({ policy, priceTable: TABLE, model: MODEL, clock: () => now })
}

function refusal(action: () => unknown): QuotaExceededError {
  try {
    action()
  } catch (error) {
    assert.ok(error instanceof QuotaExceededError, `expected a QuotaExceededError, got ${String(error)}`)
    return error
  }
  throw new assert.AssertionError({ message: 'expected the quota to refuse' })
}

function snapshotOf(q: TenantQuotas, tenant: SeamTenant) {
  const key = `${tenant.organization}/${tenant.ledgerTenant}`
  return q.snapshot().tenants.find((entry) => entry.key === key)
}

console.log('P  policy')

check('P1 a tenant cap above its organization cap, and an organization cap above the global cap, are refused', () => {
  assert.throws(() => new TenantQuotas({ policy: { ...POLICY, tenant: { ...POLICY.tenant, concurrentTurns: 4 } }, priceTable: TABLE, model: MODEL }), /tenant\.concurrentTurns must not exceed/)
  assert.throws(() => new TenantQuotas({ policy: { ...POLICY, globalConcurrentTurns: 2 }, priceTable: TABLE, model: MODEL }), /organization\.concurrentTurns must not exceed/)
})

check('P2 a zero, negative, fractional or non-numeric limit is refused', () => {
  for (const bad of [0, -1, 1.5, Number.NaN, '3' as unknown as number]) {
    assert.throws(() => new TenantQuotas({ policy: { ...POLICY, tenant: { ...POLICY.tenant, turns: { limit: bad, windowMs: 1_000 } } }, priceTable: TABLE, model: MODEL }), /positive integer/, `limit ${String(bad)}`)
  }
  assert.throws(() => new TenantQuotas({ policy: { ...POLICY, unprovenInvocation: { tokens: 1, costUsd: 0 } }, priceTable: TABLE, model: MODEL }), /positive number/)
})

check('P3 a model the frozen table does not price stops construction before any spend (ADR-20)', () => {
  assert.throws(() => new TenantQuotas({ policy: POLICY, priceTable: TABLE, model: 'model-nobody-priced' }), /no entry for model/)
})

check('P4 the shipped default policy is valid and constructs', () => {
  const q = new TenantQuotas({ policy: DEFAULT_QUOTA_POLICY, priceTable: TABLE, model: MODEL, clock: () => 0 })
  q.admitTurn(tenantOf('acme', 'default-policy')).release()
})

console.log('P  no raw tenant')

check('P5 every quota call takes a tenant derived at the seam; a string, a look-alike object or nothing is refused', () => {
  const q = quotas()
  const real = tenantOf('acme', 'u1')
  const lookalike = { organization: real.organization, ledgerTenant: real.ledgerTenant }
  for (const forged of [real.ledgerTenant, lookalike, JSON.parse(JSON.stringify(real)), null, undefined, 7]) {
    assert.throws(() => q.admitTurn(forged as never), SeamTenantRequiredError)
    assert.throws(() => q.recordLlmUsage(forged as never, MODEL, { inputTokens: 1, outputTokens: 1 }), SeamTenantRequiredError)
    assert.throws(() => q.chargeUnprovenInvocation(forged as never), SeamTenantRequiredError)
    assert.throws(() => q.admitBridgeJob(forged as never), SeamTenantRequiredError)
    assert.throws(() => q.observeLedgerBytes(forged as never, 1), SeamTenantRequiredError)
    assert.throws(() => q.forgetTenant(forged as never), SeamTenantRequiredError)
  }
  assert.equal(q.snapshot().tenants.length, 0, 'a refused forgery creates no account')
})

console.log('C  concurrency')

check('C1 a tenant at its concurrent-turn cap is refused with its own scope, and a release frees exactly one slot', () => {
  const q = quotas()
  const t = tenantOf('acme', 'u1')
  const first = q.admitTurn(t)
  q.admitTurn(t)
  const error = refusal(() => q.admitTurn(t))
  assert.deepEqual([error.scope, error.dimension, error.limit], ['tenant', 'concurrent_turns', 2])
  first.release()
  q.admitTurn(t)
  assert.equal(refusal(() => q.admitTurn(t)).dimension, 'concurrent_turns')
})

check('C2 releasing a permit twice frees one slot, not two', () => {
  const q = quotas()
  const t = tenantOf('acme', 'u1')
  const a = q.admitTurn(t)
  q.admitTurn(t)
  a.release()
  a.release()
  q.admitTurn(t)
  const error = refusal(() => q.admitTurn(t))
  assert.deepEqual([error.scope, error.dimension], ['tenant', 'concurrent_turns'], 'the double release did not open a third slot')
})

check('C3 the organization cap refuses a tenant that is within its own, naming the organization', () => {
  const q = quotas()
  const [u1, u2, u3] = [tenantOf('acme', 'u1'), tenantOf('acme', 'u2'), tenantOf('acme', 'u3')]
  q.admitTurn(u1)
  q.admitTurn(u1)
  q.admitTurn(u2)
  const error = refusal(() => q.admitTurn(u3))
  assert.deepEqual([error.scope, error.dimension, error.limit], ['organization', 'concurrent_turns', 3])
  q.admitTurn(tenantOf('globex', 'u1'))
})

check('C4 the global cap refuses when no organization is over its own', () => {
  const q = quotas()
  q.admitTurn(tenantOf('acme', 'u1'))
  q.admitTurn(tenantOf('acme', 'u2'))
  q.admitTurn(tenantOf('globex', 'u1'))
  q.admitTurn(tenantOf('globex', 'u2'))
  const error = refusal(() => q.admitTurn(tenantOf('globex', 'u3')))
  assert.deepEqual([error.scope, error.dimension, error.limit], ['global', 'concurrent_turns', 4])
})

console.log('R  rates')

check('R1 the turn rate is a rolling window with an exact retry hint, and the oldest entry leaves on the boundary', () => {
  const q = quotas()
  const t = tenantOf('acme', 'u1')
  for (const at of [0, 100, 200]) {
    now = at
    q.admitTurn(t).release()
  }
  now = 300
  const error = refusal(() => q.admitTurn(t))
  assert.deepEqual([error.scope, error.dimension, error.limit, error.retryAfterMs, error.retryAfterSeconds], ['tenant', 'turn_rate', 3, 700, 1])
  now = 999
  assert.equal(refusal(() => q.admitTurn(t)).retryAfterMs, 1, 'one millisecond before the boundary')
  now = 1_000
  q.admitTurn(t).release()
})

check('R2 the organization rate refuses tenants that are each within their own', () => {
  const q = quotas()
  let tick = 0
  for (const [subject, turns] of [['u1', 2], ['u2', 2], ['u3', 1]] as const) {
    for (let i = 0; i < turns; i += 1) {
      now = tick++
      q.admitTurn(tenantOf('acme', subject)).release()
    }
  }
  now = 10
  const error = refusal(() => q.admitTurn(tenantOf('acme', 'u4')))
  assert.deepEqual([error.scope, error.dimension, error.limit], ['organization', 'turn_rate', 5])
})

check('R3 the bridge job rate counts per tenant and per organization, and an organization-only caller counts at the organization', () => {
  const q = quotas()
  const t = tenantOf('acme', 'u1')
  q.admitBridgeJob(t)
  q.admitBridgeJob(t)
  const own = refusal(() => q.admitBridgeJob(t))
  assert.deepEqual([own.scope, own.dimension, own.limit], ['tenant', 'bridge_jobs', 2])
  q.admitBridgeJob(tenantOf('acme', 'u2'))
  const org = refusal(() => q.admitBridgeJob(tenantOf('acme', 'u3')))
  assert.deepEqual([org.scope, org.dimension, org.limit], ['organization', 'bridge_jobs', 3])
  q.admitOrganizationBridgeJob('globex')
  q.admitOrganizationBridgeJob('globex')
  q.admitOrganizationBridgeJob('globex')
  assert.equal(refusal(() => q.admitOrganizationBridgeJob('globex')).scope, 'organization')
})

check('R4 an organization id that is not path-safe is refused before an account exists', () => {
  const q = quotas()
  for (const bad of ['../x', 'ACME', '', 'a/b', 'a'.repeat(64), 'acme\n']) {
    assert.throws(() => q.admitOrganizationBridgeJob(bad), InvalidTenantIdError, JSON.stringify(bad))
  }
  assert.equal(q.snapshot().organizations.length, 0)
})

console.log('L  LLM budget')

check('L1 measured usage is priced by the frozen table: fresh input, cache-read input and output, and aliases resolve', () => {
  const q = quotas()
  const t = tenantOf('acme', 'u1')
  q.recordLlmUsage(t, MODEL, { inputTokens: 100_000, cacheReadTokens: 200_000, outputTokens: 50_000 })
  const expected = (100_000 * 0.44 + 200_000 * 0.014 + 50_000 * 1.32) / 1_000_000
  const entry = snapshotOf(q, t)!
  assert.equal(entry.llmTokens, 350_000)
  assert.equal(entry.llmCostUsd, Number(expected.toFixed(6)))
  q.recordLlmUsage(t, 'deepseek-chat', { inputTokens: 100_000, outputTokens: 0 })
  assert.equal(snapshotOf(q, t)!.llmCostUsd, Number((expected + 0.044).toFixed(6)), 'the generation alias prices as its target')
  assert.equal(q.snapshot().organizations[0]!.llmTokens, 450_000, 'the organization is charged too')
})

check('L2 an unpriced model, a malformed count or a report of zero tokens is refused and charges nothing', () => {
  const q = quotas()
  const t = tenantOf('acme', 'u1')
  assert.throws(() => q.recordLlmUsage(t, 'model-nobody-priced', { inputTokens: 1, outputTokens: 1 }), /no entry for model/)
  // no completion costs nothing: a relay that answers zeros is not measuring, and the caller must then charge the worst case
  assert.throws(() => q.recordLlmUsage(t, MODEL, { inputTokens: 0, outputTokens: 0 }), /zero tokens/)
  assert.throws(() => q.recordLlmUsage(t, MODEL, { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 }), /zero tokens/)
  for (const bad of [-1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 2]) {
    assert.throws(() => q.recordLlmUsage(t, MODEL, { inputTokens: bad, outputTokens: 1 }), RangeError, String(bad))
    assert.throws(() => q.recordLlmUsage(t, MODEL, { inputTokens: 1, outputTokens: bad }), RangeError, String(bad))
    assert.throws(() => q.recordLlmUsage(t, MODEL, { inputTokens: 1, outputTokens: 1, cacheReadTokens: bad }), RangeError, String(bad))
  }
  const entry = snapshotOf(q, t)
  assert.ok(!entry || (entry.llmTokens === 0 && entry.llmCostUsd === 0))
})

check('L3 the token budget refuses the next turn once spent, names the dimension, and reopens when the charge ages out', () => {
  const q = quotas()
  const t = tenantOf('acme', 'u1')
  q.recordLlmUsage(t, MODEL, { inputTokens: 600_000, outputTokens: 400_000 })
  now = 4_000
  const error = refusal(() => q.admitTurn(t))
  assert.deepEqual([error.scope, error.dimension, error.limit, error.retryAfterMs], ['tenant', 'llm_tokens', 1_000_000, 6_000])
  now = 10_000
  q.admitTurn(t).release()
})

check('L4 the cost budget refuses on cost alone, in dollars, before the token budget is touched', () => {
  const q = quotas()
  const t = tenantOf('acme', 'u1')
  q.recordLlmUsage(t, MODEL, { inputTokens: 0, outputTokens: 400_000 })
  assert.equal(snapshotOf(q, t)!.llmCostUsd, 0.528)
  const error = refusal(() => q.admitTurn(t))
  assert.deepEqual([error.scope, error.dimension, error.limit], ['tenant', 'llm_cost', 0.5])
})

check('L5 the organization budget is the sum of its tenants and refuses a tenant that spent nothing', () => {
  const q = quotas()
  for (const subject of ['u1', 'u2', 'u3']) q.recordLlmUsage(tenantOf('acme', subject), MODEL, { inputTokens: 700_000, outputTokens: 0 })
  const error = refusal(() => q.admitTurn(tenantOf('acme', 'fresh')))
  assert.deepEqual([error.scope, error.dimension], ['organization', 'llm_tokens'])
  q.admitTurn(tenantOf('globex', 'fresh')).release()
})

check('L6 an invocation that reported nothing is charged the configured worst case, never zero', () => {
  const q = quotas()
  const t = tenantOf('acme', 'u1')
  q.chargeUnprovenInvocation(t)
  const entry = snapshotOf(q, t)!
  assert.deepEqual([entry.llmTokens, entry.llmCostUsd], [10_000, 0.05])
  for (let i = 0; i < 9; i += 1) q.chargeUnprovenInvocation(t)
  assert.equal(refusal(() => q.admitTurn(t)).dimension, 'llm_cost', 'ten silent invocations exhaust the cost budget')
})

console.log('S  ledger size')

check('S1 a tenant ledger at its limit is refused with a long hint, one byte under is not', () => {
  const q = quotas()
  const t = tenantOf('acme', 'u1')
  q.observeLedgerBytes(t, 999)
  const error = refusal(() => q.observeLedgerBytes(t, 1_000))
  assert.deepEqual([error.scope, error.dimension, error.limit], ['tenant', 'ledger_size', 1_000])
  assert.ok(error.retryAfterSeconds >= 3_600)
})

check('S2 the organization limit is the sum of its tenants served here, and a forget takes a tenant out of it', () => {
  const q = quotas()
  const [u1, u2] = [tenantOf('acme', 'u1'), tenantOf('acme', 'u2')]
  q.observeLedgerBytes(u1, 800)
  const error = refusal(() => q.observeLedgerBytes(u2, 800))
  assert.deepEqual([error.scope, error.dimension, error.limit], ['organization', 'ledger_size', 1_500])
  q.forgetTenant(u1)
  q.observeLedgerBytes(u2, 800)
  q.observeLedgerBytes(u2, 900)
  assert.throws(() => q.observeLedgerBytes(u2, -1), RangeError)
})

console.log('I  isolation')

check('I1 a hot tenant is refused alone: its flood changes nothing for a neighbour, another organization, or the counters of either', () => {
  const q = quotas()
  const hot = tenantOf('acme', 'hot')
  let admitted = 0
  let refused = 0
  for (let i = 0; i < 1_000; i += 1) {
    try {
      q.admitTurn(hot)
      admitted += 1
    } catch (error) {
      assert.ok(error instanceof QuotaExceededError)
      assert.equal(error.scope, 'tenant')
      refused += 1
    }
  }
  assert.deepEqual([admitted, refused], [2, 998])
  const neighbour = tenantOf('acme', 'neighbour')
  const other = tenantOf('globex', 'neighbour')
  q.admitTurn(neighbour).release()
  q.admitTurn(other).release()
  assert.equal(snapshotOf(q, neighbour)!.rejected.concurrent_turns, 0)
  assert.equal(snapshotOf(q, other)!.rejected.concurrent_turns, 0)
  assert.equal(snapshotOf(q, hot)!.rejected.concurrent_turns, 998)
})

check('I2 a refusal reserves nothing: no slot, no rate entry, no account for a fresh tenant, no counter moves except the organization\'s refusal count', () => {
  const q = quotas()
  const [u1, u2, u3] = [tenantOf('acme', 'u1'), tenantOf('acme', 'u2'), tenantOf('acme', 'u3')]
  q.admitTurn(u1)
  q.admitTurn(u1)
  q.admitTurn(u2)
  const before = JSON.stringify(q.snapshot())
  refusal(() => q.admitTurn(u3))
  const after = q.snapshot()
  assert.equal(after.globalActiveTurns, 3)
  assert.equal(snapshotOf(q, u3), undefined, 'a refused fresh tenant is not remembered at all')
  const organization = after.organizations.find((entry) => entry.key === 'acme')!
  assert.equal(organization.activeTurns, 3)
  assert.equal(organization.turnsInWindow, 3)
  assert.equal(organization.rejected.concurrent_turns, 1)
  assert.notEqual(before, JSON.stringify(after), 'only the refusal count moved')
})

check('I3 counters are keyed by the organization and the HMAC tenant id and hold no subject, issuer or scope', () => {
  const q = quotas()
  const t = tenantOf('acme', 'alice@example.com')
  q.admitTurn(t).release()
  q.recordLlmUsage(t, MODEL, { inputTokens: 1, outputTokens: 1 })
  const text = JSON.stringify(q.snapshot())
  assert.match(q.snapshot().tenants[0]!.key, /^acme\/t-[0-9a-f]{32}$/)
  for (const secret of ['alice', 'example.com', 'idp.example', 'booking:read']) assert.ok(!text.includes(secret), `snapshot leaks ${secret}`)
})

check('I4 idle accounts are swept and take their ledger size out of the organization total; a live turn keeps its account', () => {
  const q = quotas()
  const keeper = tenantOf('acme', 'keeper')
  q.observeLedgerBytes(keeper, 10)
  assert.equal(q.snapshot().organizations.find((entry) => entry.key === 'acme')?.ledgerBytes, 10)
  const live = tenantOf('acme', 'live')
  const held = q.admitTurn(live)
  for (let i = 0; i < 1_100; i += 1) {
    now = i * 5_000
    q.admitTurn(tenantOf(i % 2 === 0 ? 'acme' : 'globex', `churn-${i}`)).release()
  }
  const keys = new Set(q.snapshot().tenants.map((entry) => entry.key))
  assert.ok(keys.size < 200, `idle tenants were swept at the thousandth admission (${keys.size} left of 1102)`)
  assert.ok(!keys.has(`acme/${keeper.ledgerTenant}`), 'an idle tenant is swept although its ledger has a size')
  assert.ok(keys.has(`acme/${live.ledgerTenant}`), 'a live turn keeps its account')
  assert.equal(q.snapshot().organizations.find((entry) => entry.key === 'acme')?.ledgerBytes, 0, 'the swept ledger left the organization total')
  held.release()
})

check('I6 a fresh tenant that is refused leaves no account behind, and refused attempts advance the sweep', () => {
  // rates are out of the way: only the organization's concurrency cap (3) refuses here
  const q = quotas({ ...POLICY, tenant: { ...POLICY.tenant, turns: { limit: 1_000_000, windowMs: 1_000 } }, organization: { ...POLICY.organization, turns: { limit: 1_000_000, windowMs: 1_000 } } })
  const idleTenants = Array.from({ length: 10 }, (_, n) => tenantOf('acme', `early-${n}`))
  for (const tenant of idleTenants) q.admitTurn(tenant).release()
  const holders = [tenantOf('acme', 'h1'), tenantOf('acme', 'h2'), tenantOf('acme', 'h3')].map((tenant) => q.admitTurn(tenant))
  // the organization cap (3) is full: every further tenant is refused, and none of them may be remembered
  now = 1_000_000
  for (let i = 0; i < 1_100; i += 1) {
    refusal(() => q.admitTurn(tenantOf('acme', `flood-${i}`)))
    assert.ok(q.snapshot().tenants.length <= 13, 'a refused tenant was registered')
  }
  const keys = q.snapshot().tenants.map((entry) => entry.key)
  assert.ok(!idleTenants.some((tenant) => keys.includes(`acme/${tenant.ledgerTenant}`)), 'the refused attempts advanced the sweep: the idle tenants are gone')
  assert.equal(keys.length, 3, 'only the three live turns hold an account')
  for (const holder of holders) holder.release()
})

check('I5 a refusal is a typed tenant-state error with a code, a scope and a hint, and its message names no person', () => {
  const q = quotas()
  const t = tenantOf('acme', 'alice@example.com')
  q.admitTurn(t)
  q.admitTurn(t)
  const error = refusal(() => q.admitTurn(t))
  assert.ok(error instanceof TenantStateError)
  assert.equal(error.code, 'GOTRY_QUOTA_EXCEEDED')
  assert.ok(Number.isInteger(error.retryAfterMs) && error.retryAfterMs >= 1)
  assert.ok(!error.message.includes('alice') && !error.message.includes(t.ledgerTenant))
})

console.log(`tenant-seam quota tests: ${passed} checks passed`)
