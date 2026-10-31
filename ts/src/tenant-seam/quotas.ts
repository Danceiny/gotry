/**
 * Quotas and metering per tenant and per organization (docs/rfc/aaas-rfc.md §4.4, threats S-10 and S-11).
 *
 * One tenant must not be able to move another tenant's latency budget, and one organization must not be able to
 * move another organization's. The meter therefore counts at two scopes (the ledger tenant and its organization) and
 * a global concurrency cap, and refuses with a typed `QuotaExceededError` (HTTP 429) before the expensive work: a
 * refused turn is turned away after authentication and before the request body is read, the lease is acquired or a
 * planner is started.
 *
 * Dimensions: concurrent turns, turn rate, LLM tokens and cost (priced by the frozen ADR-20 table, in the same code
 * the nightly evidence uses), bridge job rate, and ledger size. Windows are rolling, driven by an injected
 * monotonic clock. The LLM budget is checked before a turn and charged after it, so it can be overshot by the
 * turns in flight: a soft cap, by design. A planner invocation that reports no usage (or zero tokens) is charged the
 * configured worst case instead of nothing, so a silent or zero-answering feed cannot make the budget unreachable.
 *
 * State is per replica. Tenant-affine routing gives a tenant one owner, so tenant quotas hold fleet-wide; an
 * organization's quota is per replica until a shared counter is chosen (A3).
 */

import { assertModelPriced, priceMeasuredUsage, type LlmPriceTable, type MeasuredLlmUsage } from '../llm-price-table.ts'
import { TenantStateError } from '../tenant-state/errors.ts'
import { assertOrganizationId } from '../tenant-state/ids.ts'
import { assertSeamTenant, seamTenantKey, type SeamTenant } from './seam.ts'

export type QuotaScope = 'tenant' | 'organization' | 'global'
export type QuotaDimension = 'concurrent_turns' | 'turn_rate' | 'llm_tokens' | 'llm_cost' | 'bridge_jobs' | 'ledger_size'

export const QUOTA_DIMENSIONS: readonly QuotaDimension[] = ['concurrent_turns', 'turn_rate', 'llm_tokens', 'llm_cost', 'bridge_jobs', 'ledger_size']

/** A turn that found every slot taken has no better hint than "soon". */
const CONCURRENCY_RETRY_AFTER_MS = 1_000
/** A full ledger frees up only by an operator action, so the hint is long. */
const LEDGER_RETRY_AFTER_MS = 3_600_000
const MICRO = 1_000_000
const SWEEP_EVERY = 1_000

/** Refused by a quota. Carries the narrowest scope that refused, the dimension and a retry hint; no personal data. */
export class QuotaExceededError extends TenantStateError {
  readonly scope: QuotaScope
  readonly dimension: QuotaDimension
  readonly limit: number
  readonly retryAfterMs: number

  constructor(scope: QuotaScope, dimension: QuotaDimension, limit: number, retryAfterMs: number) {
    super('GOTRY_QUOTA_EXCEEDED', `${scope} quota exceeded: ${dimension}`)
    this.scope = scope
    this.dimension = dimension
    this.limit = limit
    this.retryAfterMs = Math.max(1, Math.ceil(retryAfterMs))
  }

  /** Whole seconds for a `Retry-After` header, at least one. */
  get retryAfterSeconds(): number {
    return Math.max(1, Math.ceil(this.retryAfterMs / 1_000))
  }
}

export interface RateLimit {
  readonly limit: number
  readonly windowMs: number
}

export interface QuotaLimits {
  readonly concurrentTurns: number
  readonly turns: RateLimit
  readonly llm: { readonly tokens: number; readonly costUsd: number; readonly windowMs: number }
  readonly bridgeJobs: RateLimit
  readonly ledgerBytes: number
}

export interface QuotaPolicy {
  readonly tenant: QuotaLimits
  readonly organization: QuotaLimits
  readonly globalConcurrentTurns: number
  /** What one planner invocation that reported no usage is charged: the worst case, never zero. */
  readonly unprovenInvocation: { readonly tokens: number; readonly costUsd: number }
}

/**
 * Starting values, not a decision: they are conservative and unreviewed, and a deployment sets its own.
 * Each tenant cap sits below its organization's, and each organization's below the global one, so that no single
 * tenant can fill an organization and no single organization can fill the service.
 */
export const DEFAULT_QUOTA_POLICY: QuotaPolicy = Object.freeze({
  tenant: {
    concurrentTurns: 2,
    turns: { limit: 30, windowMs: 60_000 },
    llm: { tokens: 400_000, costUsd: 2, windowMs: 3_600_000 },
    bridgeJobs: { limit: 12, windowMs: 60_000 },
    ledgerBytes: 64 * 1024 * 1024,
  },
  organization: {
    concurrentTurns: 16,
    turns: { limit: 600, windowMs: 60_000 },
    llm: { tokens: 20_000_000, costUsd: 100, windowMs: 3_600_000 },
    bridgeJobs: { limit: 120, windowMs: 60_000 },
    ledgerBytes: 8 * 1024 * 1024 * 1024,
  },
  globalConcurrentTurns: 64,
  unprovenInvocation: { tokens: 50_000, costUsd: 0.25 },
})

export interface TurnPermit {
  /** Frees the concurrency slot. Idempotent. */
  release(): void
}

export interface QuotaAccountSnapshot {
  readonly key: string
  readonly activeTurns: number
  readonly turnsInWindow: number
  readonly llmTokens: number
  readonly llmCostUsd: number
  readonly bridgeJobs: number
  readonly ledgerBytes: number
  readonly rejected: Readonly<Record<QuotaDimension, number>>
}

export interface QuotaSnapshot {
  readonly globalActiveTurns: number
  readonly tenants: readonly QuotaAccountSnapshot[]
  readonly organizations: readonly QuotaAccountSnapshot[]
}

export interface TenantQuotasOptions {
  readonly policy: QuotaPolicy
  readonly priceTable: LlmPriceTable
  /** The model the planner runs. One the frozen table does not price stops the service before any spend (ADR-20). */
  readonly model: string
  /** Monotonic milliseconds. Suites drive it by hand. */
  readonly clock?: () => number
}

/** A rolling window of amounts: the sum of what was added in the last `windowMs`. */
class RollingSum {
  private readonly entries: Array<[number, number]> = []
  private head = 0
  private total = 0
  readonly windowMs: number

  constructor(windowMs: number) {
    this.windowMs = windowMs
  }

  private prune(now: number): void {
    const horizon = now - this.windowMs
    while (this.head < this.entries.length && this.entries[this.head]![0] <= horizon) {
      this.total -= this.entries[this.head]![1]
      this.head += 1
    }
    if (this.head > 1_024 && this.head * 2 > this.entries.length) {
      this.entries.splice(0, this.head)
      this.head = 0
    }
  }

  sum(now: number): number {
    this.prune(now)
    return this.total
  }

  add(now: number, amount: number): void {
    this.prune(now)
    this.entries.push([now, amount])
    this.total += amount
  }

  /** Milliseconds until the sum falls strictly below `limit` if nothing more is added; 0 when it already is. */
  msUntilBelow(now: number, limit: number): number {
    this.prune(now)
    let remaining = this.total
    if (remaining < limit) return 0
    for (let index = this.head; index < this.entries.length; index += 1) {
      remaining -= this.entries[index]![1]
      if (remaining < limit) return Math.max(1, this.entries[index]![0] + this.windowMs - now)
    }
    return this.windowMs
  }

  idle(now: number): boolean {
    this.prune(now)
    return this.head === this.entries.length
  }
}

class Account {
  active = 0
  readonly turns: RollingSum
  readonly tokens: RollingSum
  readonly costMicro: RollingSum
  readonly bridge: RollingSum
  ledgerBytes = 0
  readonly rejected: Record<QuotaDimension, number> = { concurrent_turns: 0, turn_rate: 0, llm_tokens: 0, llm_cost: 0, bridge_jobs: 0, ledger_size: 0 }

  constructor(limits: QuotaLimits) {
    this.turns = new RollingSum(limits.turns.windowMs)
    this.tokens = new RollingSum(limits.llm.windowMs)
    this.costMicro = new RollingSum(limits.llm.windowMs)
    this.bridge = new RollingSum(limits.bridgeJobs.windowMs)
  }

  /** No live turn and nothing left in any window. The ledger size is not part of it: the sweep takes it out of the organization total. */
  idle(now: number): boolean {
    return this.active === 0 && this.turns.idle(now) && this.tokens.idle(now) && this.costMicro.idle(now) && this.bridge.idle(now)
  }
}

function positiveInteger(name: string, value: unknown): void {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) throw new RangeError(`${name} must be a positive integer`)
}

function positiveNumber(name: string, value: unknown): void {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) throw new RangeError(`${name} must be a positive number`)
}

function validateLimits(scope: string, limits: QuotaLimits): void {
  positiveInteger(`${scope}.concurrentTurns`, limits.concurrentTurns)
  positiveInteger(`${scope}.turns.limit`, limits.turns.limit)
  positiveInteger(`${scope}.turns.windowMs`, limits.turns.windowMs)
  positiveInteger(`${scope}.llm.tokens`, limits.llm.tokens)
  positiveNumber(`${scope}.llm.costUsd`, limits.llm.costUsd)
  positiveInteger(`${scope}.llm.windowMs`, limits.llm.windowMs)
  positiveInteger(`${scope}.bridgeJobs.limit`, limits.bridgeJobs.limit)
  positiveInteger(`${scope}.bridgeJobs.windowMs`, limits.bridgeJobs.windowMs)
  positiveInteger(`${scope}.ledgerBytes`, limits.ledgerBytes)
}

function validatePolicy(policy: QuotaPolicy): void {
  validateLimits('tenant', policy.tenant)
  validateLimits('organization', policy.organization)
  positiveInteger('globalConcurrentTurns', policy.globalConcurrentTurns)
  positiveInteger('unprovenInvocation.tokens', policy.unprovenInvocation.tokens)
  positiveNumber('unprovenInvocation.costUsd', policy.unprovenInvocation.costUsd)
  // A tenant cap above its organization's can never bind, and an organization above the global one lets it starve the rest.
  if (policy.tenant.concurrentTurns > policy.organization.concurrentTurns) throw new RangeError('tenant.concurrentTurns must not exceed organization.concurrentTurns')
  if (policy.organization.concurrentTurns > policy.globalConcurrentTurns) throw new RangeError('organization.concurrentTurns must not exceed globalConcurrentTurns')
}

export class TenantQuotas {
  private readonly policy: QuotaPolicy
  private readonly priceTable: LlmPriceTable
  private readonly clock: () => number
  private readonly tenants = new Map<string, Account>()
  private readonly organizations = new Map<string, Account>()
  private globalActive = 0
  private admissions = 0

  constructor(options: TenantQuotasOptions) {
    validatePolicy(options.policy)
    assertModelPriced(options.model, options.priceTable)
    this.policy = options.policy
    this.priceTable = options.priceTable
    this.clock = options.clock ?? (() => performance.now())
  }

  /**
   * Admits one turn or refuses it. Checks run narrowest scope first (tenant, organization, global) so a hot tenant is
   * told it hit its own limit, and an innocent one only ever sees an organization limit that the sum really reached.
   * Nothing is reserved unless every check passes.
   */
  admitTurn(tenant: SeamTenant): TurnPermit {
    const seam = assertSeamTenant(tenant)
    const now = this.clock()
    // Every attempt counts toward the sweep, so a flood of refused attempts cannot outrun it.
    this.maybeSweep(now)
    const key = seamTenantKey(seam)
    // A tenant is registered only when a turn is admitted: a fresh tenant that is refused leaves nothing behind.
    const known = this.tenants.get(key)
    const tenantAccount = known ?? new Account(this.policy.tenant)
    const organizationAccount = this.organizationAccount(seam.organization)
    const { policy } = this
    this.refuseIfOver(tenantAccount, 'tenant', 'concurrent_turns', tenantAccount.active, policy.tenant.concurrentTurns, CONCURRENCY_RETRY_AFTER_MS)
    this.refuseIfOverRolling(tenantAccount, 'tenant', 'turn_rate', tenantAccount.turns, now, policy.tenant.turns.limit)
    this.refuseIfOverRolling(tenantAccount, 'tenant', 'llm_tokens', tenantAccount.tokens, now, policy.tenant.llm.tokens)
    this.refuseIfOverRolling(tenantAccount, 'tenant', 'llm_cost', tenantAccount.costMicro, now, Math.round(policy.tenant.llm.costUsd * MICRO), MICRO)
    this.refuseIfOver(organizationAccount, 'organization', 'concurrent_turns', organizationAccount.active, policy.organization.concurrentTurns, CONCURRENCY_RETRY_AFTER_MS)
    this.refuseIfOverRolling(organizationAccount, 'organization', 'turn_rate', organizationAccount.turns, now, policy.organization.turns.limit)
    this.refuseIfOverRolling(organizationAccount, 'organization', 'llm_tokens', organizationAccount.tokens, now, policy.organization.llm.tokens)
    this.refuseIfOverRolling(organizationAccount, 'organization', 'llm_cost', organizationAccount.costMicro, now, Math.round(policy.organization.llm.costUsd * MICRO), MICRO)
    this.refuseIfOver(organizationAccount, 'global', 'concurrent_turns', this.globalActive, policy.globalConcurrentTurns, CONCURRENCY_RETRY_AFTER_MS)
    if (!known) this.tenants.set(key, tenantAccount)
    tenantAccount.active += 1
    organizationAccount.active += 1
    this.globalActive += 1
    tenantAccount.turns.add(now, 1)
    organizationAccount.turns.add(now, 1)
    let released = false
    return {
      release: () => {
        if (released) return
        released = true
        tenantAccount.active -= 1
        organizationAccount.active -= 1
        this.globalActive -= 1
      },
    }
  }

  /**
   * Charges measured usage, priced by the frozen table. Throws for an unpriced model, malformed counts or a report of zero
   * tokens (no completion costs nothing, so a relay that answers zeros is not measuring); the caller then charges the worst case.
   */
  recordLlmUsage(tenant: SeamTenant, model: string, usage: MeasuredLlmUsage): void {
    const seam = assertSeamTenant(tenant)
    const priced = priceMeasuredUsage(model, usage, this.priceTable)
    if (priced.tokens === 0) throw new RangeError('a usage report of zero tokens proves nothing')
    this.charge(seam, priced.tokens, Math.round(priced.costUsd * MICRO))
  }

  /** Charges one planner invocation that reported no usable usage: the configured worst case. */
  chargeUnprovenInvocation(tenant: SeamTenant): void {
    const seam = assertSeamTenant(tenant)
    this.charge(seam, this.policy.unprovenInvocation.tokens, Math.round(this.policy.unprovenInvocation.costUsd * MICRO))
  }

  /** Counts one bridge job for a tenant and its organization, or refuses it. */
  admitBridgeJob(tenant: SeamTenant): void {
    const seam = assertSeamTenant(tenant)
    const now = this.clock()
    const tenantAccount = this.tenantAccount(seamTenantKey(seam))
    const organizationAccount = this.organizationAccount(seam.organization)
    this.refuseIfOverRolling(tenantAccount, 'tenant', 'bridge_jobs', tenantAccount.bridge, now, this.policy.tenant.bridgeJobs.limit)
    this.refuseIfOverRolling(organizationAccount, 'organization', 'bridge_jobs', organizationAccount.bridge, now, this.policy.organization.bridgeJobs.limit)
    tenantAccount.bridge.add(now, 1)
    organizationAccount.bridge.add(now, 1)
  }

  /** The same for a caller that is known only by organization, such as the extension lane's HTTP surface. */
  admitOrganizationBridgeJob(organization: string): void {
    const now = this.clock()
    const organizationAccount = this.organizationAccount(assertOrganizationId(organization))
    this.refuseIfOverRolling(organizationAccount, 'organization', 'bridge_jobs', organizationAccount.bridge, now, this.policy.organization.bridgeJobs.limit)
    organizationAccount.bridge.add(now, 1)
  }

  /**
   * Records the size of a tenant's ledger and refuses while it is at its limit, or while the ledgers of the
   * organization's tenants served here add up to the organization's limit.
   */
  observeLedgerBytes(tenant: SeamTenant, bytes: number): void {
    const seam = assertSeamTenant(tenant)
    if (!Number.isSafeInteger(bytes) || bytes < 0) throw new RangeError('bytes must be a non-negative integer')
    const tenantAccount = this.tenantAccount(seamTenantKey(seam))
    const organizationAccount = this.organizationAccount(seam.organization)
    organizationAccount.ledgerBytes += bytes - tenantAccount.ledgerBytes
    tenantAccount.ledgerBytes = bytes
    this.refuseIfOver(tenantAccount, 'tenant', 'ledger_size', bytes, this.policy.tenant.ledgerBytes, LEDGER_RETRY_AFTER_MS)
    this.refuseIfOver(organizationAccount, 'organization', 'ledger_size', organizationAccount.ledgerBytes, this.policy.organization.ledgerBytes, LEDGER_RETRY_AFTER_MS)
  }

  /** Forgets a tenant's counters (after a forget, or when its ledger leaves this replica). */
  forgetTenant(tenant: SeamTenant): void {
    const seam = assertSeamTenant(tenant)
    const key = seamTenantKey(seam)
    const account = this.tenants.get(key)
    if (!account) return
    const organizationAccount = this.organizations.get(seam.organization)
    if (organizationAccount) organizationAccount.ledgerBytes -= account.ledgerBytes
    this.tenants.delete(key)
  }

  /** Counters keyed by `<organization>/<hmac tenant id>`: nothing that names a person. */
  snapshot(): QuotaSnapshot {
    const now = this.clock()
    const describe = (key: string, account: Account): QuotaAccountSnapshot => ({
      key,
      activeTurns: account.active,
      turnsInWindow: account.turns.sum(now),
      llmTokens: account.tokens.sum(now),
      llmCostUsd: account.costMicro.sum(now) / MICRO,
      bridgeJobs: account.bridge.sum(now),
      ledgerBytes: account.ledgerBytes,
      rejected: { ...account.rejected },
    })
    return {
      globalActiveTurns: this.globalActive,
      tenants: [...this.tenants].map(([key, account]) => describe(key, account)),
      organizations: [...this.organizations].map(([key, account]) => describe(key, account)),
    }
  }

  private charge(seam: SeamTenant, tokens: number, costMicro: number): void {
    const now = this.clock()
    for (const account of [this.tenantAccount(seamTenantKey(seam)), this.organizationAccount(seam.organization)]) {
      account.tokens.add(now, tokens)
      account.costMicro.add(now, costMicro)
    }
  }

  private tenantAccount(key: string): Account {
    let account = this.tenants.get(key)
    if (!account) {
      account = new Account(this.policy.tenant)
      this.tenants.set(key, account)
    }
    return account
  }

  private organizationAccount(organization: string): Account {
    let account = this.organizations.get(organization)
    if (!account) {
      account = new Account(this.policy.organization)
      this.organizations.set(organization, account)
    }
    return account
  }

  /** Refuses when `used` has reached `limit`. */
  private refuseIfOver(account: Account, scope: QuotaScope, dimension: QuotaDimension, used: number, limit: number, retryAfterMs: number): void {
    if (used < limit) return
    account.rejected[dimension] += 1
    throw new QuotaExceededError(scope, dimension, limit, retryAfterMs)
  }

  private refuseIfOverRolling(account: Account, scope: QuotaScope, dimension: QuotaDimension, window: RollingSum, now: number, limit: number, unit = 1): void {
    if (window.sum(now) < limit) return
    account.rejected[dimension] += 1
    throw new QuotaExceededError(scope, dimension, limit / unit, window.msUntilBelow(now, limit))
  }

  private maybeSweep(now: number): void {
    this.admissions += 1
    if (this.admissions % SWEEP_EVERY !== 0) return
    for (const [key, account] of this.tenants) {
      if (!account.idle(now)) continue
      this.tenants.delete(key)
      // The tenant's ledger leaves the organization's total with its account; its next turn observes the size again.
      const organizationAccount = this.organizations.get(key.slice(0, key.indexOf('/')))
      if (organizationAccount) organizationAccount.ledgerBytes -= account.ledgerBytes
    }
    for (const [key, account] of this.organizations) if (account.idle(now) && account.ledgerBytes === 0) this.organizations.delete(key)
  }
}
