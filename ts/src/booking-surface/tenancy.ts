/**
 * Multi-tenant seam of the Booking Copilot surface (AaaS A2, docs/rfc/aaas-rfc.md §4.4; threats S-1 to S-4, S-10, S-13, S-14).
 *
 * One request becomes one `TurnScope` here and nowhere else:
 *
 *   authenticate -> deriveSeamTenant -> quotas.admitTurn -> router.openTenant -> a runtime over the tenant's guarded ledger
 *
 * The tenant comes from the authenticated caller only. The body, the headers, the tool arguments and the model's output
 * are never inputs to it, and the scope carries no method that takes a tenant. Everything the surface keeps between
 * requests (planner sessions, single-flight decisions) is keyed by the scope, so two tenants whose task handles and
 * request keys collide still never meet. The shared, single-ledger form of the surface (today's deployment) does not
 * use this module and behaves exactly as before.
 */

import { AsyncLocalStorage } from 'node:async_hooks'
import type { MeasuredLlmUsage } from '../llm-price-table.ts'
import { assertSeamTenant, deriveSeamTenant, InvalidPrincipalError, SeamError, seamTenantKey, UnknownOrganizationError, type AuthenticatedCaller, type CallerAuthenticator, type CallerRequest, type OrganizationKeyring, type SeamTenant } from '../tenant-seam/seam.ts'
import { QuotaExceededError, type TenantQuotas } from '../tenant-seam/quotas.ts'
import { InvalidTenantIdError, ReplicaAtCapacityError, RouterClosedError, TenantDrainingError, TenantStateError } from '../tenant-state/errors.ts'
import { derivePromptCachePartition } from '../tenant-state/ids.ts'
import type { TenantHandle, TenantRouter } from '../tenant-state/tenant-router.ts'
import type { BookingCopilotIngressMode, BookingIngressBinding, BookingIngressPrincipal } from './contracts.ts'
import { BookingCopilotTaskRuntime, type BookingCopilotRuntimeOptions, type BookingPlannerSession, type BookingPlannerSessionFactory } from './runtime.ts'

/** What a deployment gives the planner for one tenant. */
export interface TenantPlannerContext {
  /** The tenant's own directory. Planner working files and session state go here, never beside another tenant's. */
  readonly tenantRoot: string
  /**
   * The tenant's prompt cache partition label (`derivePromptCachePartition`). A planner puts it into every prompt ahead
   * of anything tenant-derived, so a provider's prefix cache is never shared between tenants past the shared instructions.
   */
  readonly cachePartition: string
  /**
   * Reports the measured usage of the planner invocation in progress, priced against the frozen table. A report from
   * outside an invocation of this tenant is dropped, never charged to anyone else.
   */
  reportUsage(model: string, usage: MeasuredLlmUsage): void
}

export interface TenantPlannerProvider {
  /** The planner session factory of one tenant. Called once per tenant and cached. */
  forTenant(context: TenantPlannerContext): Promise<BookingPlannerSessionFactory>
  close(): Promise<void>
}

/** One planner shared by every tenant. Sessions are still keyed by tenant here, but the planner's own files are shared: for fixtures. */
export function sharedPlannerProvider(factory: BookingPlannerSessionFactory): TenantPlannerProvider {
  return { forTenant: async () => factory, close: async () => undefined }
}

export interface BookingTenancyOptions {
  readonly authenticator: CallerAuthenticator
  readonly keyring: OrganizationKeyring
  readonly router: TenantRouter
  readonly quotas: TenantQuotas
  readonly planners: TenantPlannerProvider
  readonly runtime?: BookingCopilotRuntimeOptions
  /** The in-process BFF identity seam of ADR-23. Absent: ingress turns are refused, as in bound-turn-only. */
  readonly ingressBinding?: BookingIngressBinding
}

/** What the surface needs for one request. Built by the tenancy, or by the server for the shared form. */
export interface TurnScope {
  /** `<organization>/<hmac tenant>`, or `null` for the shared single-ledger form. */
  readonly key: string | null
  readonly runtime: BookingCopilotTaskRuntime
  readonly plannerFactory: BookingPlannerSessionFactory
  readonly ingress: { readonly binding: BookingIngressBinding; readonly principal: BookingIngressPrincipal } | null
  /** Key of a planner session in the composition-wide map. Equal to the task id in the shared form. */
  sessionKey(taskId: string): string
  /** Key of a decision flight in the composition-wide map. Unchanged in the shared form. */
  flightKey(parts: readonly unknown[]): string
  /** Runs the decision work (the planner await and the ledger write that follows). Tenant form: leased, drained by a handoff, acknowledged only if the lease held. */
  runDecision<T>(work: () => Promise<T>): Promise<T>
  /** True for a failure of the tenant's availability (lease, fence, handoff, store) rather than of the request. */
  isTenantFault(error: unknown): boolean
  /** Frees the concurrency slot. Call exactly once, when the response is over. */
  release(): void
}

/** The handle and the ledger it exposes disagree with the tenant the seam derived: a wiring bug that must never serve a request. */
export class TenantBindingError extends SeamError {
  constructor() {
    super('GOTRY_SEAM_TENANT_MISMATCH', 'the opened ledger does not belong to the derived tenant')
  }
}

interface InvocationMeter {
  readonly tenantKey: string
  reported: boolean
}

const invocations = new AsyncLocalStorage<InvocationMeter>()

function ledgerBytes(handle: TenantHandle): number {
  return handle.run((ledger) => {
    const pages = ledger.db.pragma('page_count', { simple: true }) as number
    const size = ledger.db.pragma('page_size', { simple: true }) as number
    return pages * size
  })
}

export class BookingTenancy {
  readonly ingressMode: BookingCopilotIngressMode
  private readonly options: BookingTenancyOptions
  private readonly planners = new Map<string, Promise<BookingPlannerSessionFactory>>()

  constructor(options: BookingTenancyOptions) {
    if (typeof options.authenticator?.authenticate !== 'function') throw new Error('booking_copilot_tenancy_authenticator_required')
    if (typeof options.keyring?.keyFor !== 'function') throw new Error('booking_copilot_tenancy_keyring_required')
    if (!options.router || !options.quotas || !options.planners) throw new Error('booking_copilot_tenancy_incomplete')
    if (options.ingressBinding !== undefined && typeof options.ingressBinding.bind !== 'function') throw new Error('booking_copilot_ingress_binding_invalid')
    this.options = options
    this.ingressMode = options.ingressBinding ? 'bff-ingress-binding' : 'bff-bound-turn-only'
  }

  /** The authenticated caller of a request, or `null`. The only place a credential is read. */
  async authenticate(request: CallerRequest): Promise<AuthenticatedCaller | null> {
    return this.options.authenticator.authenticate(request)
  }

  /**
   * Derives the tenant, admits the turn, and opens the tenant's guarded ledger.
   *
   * @throws QuotaExceededError before any lease or file is touched, when the turn is over a limit
   * @throws InvalidTenantIdError | InvalidPrincipalError | UnknownOrganizationError for a caller the seam cannot place
   * @throws TenantStateError subclasses when the tenant cannot be served here now (owned elsewhere, draining, store down)
   */
  async beginTurn(caller: AuthenticatedCaller): Promise<TurnScope> {
    const { quotas, router } = this.options
    const tenant = deriveSeamTenant(caller, this.options.keyring)
    const permit = quotas.admitTurn(tenant)
    try {
      const handle = await router.openTenant(tenant.organization, tenant.ledgerTenant)
      // Defense in depth: the handle, and the ledger inside it, must be exactly the tenant the seam derived.
      if (handle.organization !== tenant.organization || handle.ledgerTenant !== tenant.ledgerTenant || handle.ledger.tenant !== tenant.ledgerTenant) throw new TenantBindingError()
      quotas.observeLedgerBytes(tenant, ledgerBytes(handle))
      const plannerFactory = await this.plannerFor(tenant)
      const key = seamTenantKey(tenant)
      const runtime = new BookingCopilotTaskRuntime(handle.ledger, this.options.runtime)
      const binding = this.options.ingressBinding
      return {
        key,
        runtime,
        plannerFactory,
        ingress: binding ? { binding, principal: { subject: caller.subject, scope: caller.scope } } : null,
        sessionKey: (taskId) => `${key}\u0000${taskId}`,
        flightKey: (parts) => JSON.stringify([key, ...parts]),
        runDecision: (work) => handle.runAsync(work),
        isTenantFault: (error) => error instanceof TenantStateError,
        release: () => permit.release(),
      }
    } catch (error) {
      permit.release()
      throw error
    }
  }

  /**
   * Hands every tenant back and stops the planners. The tenancy owns the router and the planner provider it was given:
   * a graceful handoff per tenant (drain, final snapshot, release), then the planners. Resolves when done; a tenant whose
   * final snapshot could not be flushed is reported, because its last writes are then only as durable as the last snapshot.
   */
  async close(): Promise<void> {
    const failures: unknown[] = []
    try { await this.options.planners.close() } catch (error) { failures.push(error) }
    const unflushed = await this.options.router.close().catch((error: unknown) => { failures.push(error); return [] as string[] })
    if (unflushed.length > 0) failures.push(new Error(`booking_copilot_tenant_handoff_unflushed:${unflushed.length}`))
    if (failures.length === 1) throw failures[0]
    if (failures.length > 1) throw new AggregateError(failures, 'booking_copilot_tenancy_close_failed')
  }

  private plannerFor(tenant: SeamTenant): Promise<BookingPlannerSessionFactory> {
    const seam = assertSeamTenant(tenant)
    const key = seamTenantKey(seam)
    let planner = this.planners.get(key)
    if (!planner) {
      const { quotas, planners, router } = this.options
      const organizationKey = this.options.keyring.keyFor(seam.organization)
      if (organizationKey === null) throw new UnknownOrganizationError()
      planner = planners.forTenant({
        tenantRoot: router.tenantRootOf(seam.organization, seam.ledgerTenant),
        cachePartition: derivePromptCachePartition(organizationKey, seam.ledgerTenant),
        reportUsage: (model, usage) => {
          const meter = invocations.getStore()
          if (!meter || meter.tenantKey !== key) return
          try {
            quotas.recordLlmUsage(seam, model, usage)
            meter.reported = true
          } catch {
            // An unpriced model or malformed counts leave the invocation unproven: it is charged the worst case below.
          }
        },
      }).then((inner) => (task) => this.metered(inner(task), seam, key))
      planner.catch(() => this.planners.delete(key))
      this.planners.set(key, planner)
    }
    return planner
  }

  /** Wraps a planner session so that every invocation is charged: what it reported, or the worst case if it reported nothing. */
  private metered(session: BookingPlannerSession, tenant: SeamTenant, key: string): BookingPlannerSession {
    const { quotas } = this.options
    return {
      next: async (input) => {
        const meter: InvocationMeter = { tenantKey: key, reported: false }
        try {
          return await invocations.run(meter, () => session.next(input))
        } finally {
          if (!meter.reported) quotas.chargeUnprovenInvocation(tenant)
        }
      },
      ...(session.close ? { close: () => session.close!() } : {}),
    }
  }
}

export interface TenantRejection {
  readonly status: number
  readonly body: { readonly error: Record<string, unknown> }
  readonly retryAfterSeconds?: number
}

/** The typed HTTP answer for a failure raised before the response stream starts. Bodies carry codes, scopes and hints only. */
export function tenantRejection(error: unknown): TenantRejection {
  if (error instanceof QuotaExceededError) {
    return {
      status: 429,
      body: { error: { code: 'quota_exceeded', scope: error.scope, dimension: error.dimension, retryAfterSeconds: error.retryAfterSeconds } },
      retryAfterSeconds: error.retryAfterSeconds,
    }
  }
  if (error instanceof InvalidTenantIdError || error instanceof InvalidPrincipalError) return { status: 403, body: { error: { code: 'invalid_principal' } } }
  if (error instanceof UnknownOrganizationError) return { status: 403, body: { error: { code: 'organization_not_served' } } }
  if (error instanceof RouterClosedError) return { status: 503, body: { error: { code: 'booking_copilot_shutting_down' } } }
  if (error instanceof TenantDrainingError) return { status: 503, body: { error: { code: 'tenant_draining' } }, retryAfterSeconds: 1 }
  // A full replica frees a slot only when some tenant is handed off, so retrying it soon is not a useful hint; the request belongs on another replica.
  if (error instanceof ReplicaAtCapacityError) return { status: 503, body: { error: { code: 'tenant_unavailable' } } }
  if (error instanceof TenantStateError && !(error instanceof SeamError)) return { status: 503, body: { error: { code: 'tenant_unavailable' } }, retryAfterSeconds: 1 }
  return { status: 500, body: { error: { code: 'tenant_seam_failure' } } }
}
