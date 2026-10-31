/**
 * The trusted seam of the AaaS line (docs/rfc/aaas-rfc.md §4.4, threats S-1, S-3, S-13).
 *
 * Exactly one place turns "who is calling" into "whose ledger": `deriveSeamTenant`. It takes the caller an
 * authenticator vouched for, and a per-organization key, and returns the ledger tenant as an HMAC digest
 * (`deriveLedgerTenantId`). Nothing a request body, a header, a tool argument or a model output says is ever an
 * input to it, and every API that needs a tenant takes the `SeamTenant` it returns, never a string.
 *
 * What the authenticator is, on the wire, is not decided here: the A3 boundary ADR chooses per-organization
 * credentials or signed assertions. The authenticator is an in-process interface so that decision can land
 * without touching the seam.
 */

import type { IncomingHttpHeaders } from 'node:http'
import { TenantStateError } from '../tenant-state/errors.ts'
import { assertOrganizationId, deriveLedgerTenantId } from '../tenant-state/ids.ts'

declare const seamBrand: unique symbol

const MAX_PRINCIPAL_FIELD_CHARS = 256

/** The authenticated caller, as vouched for by the BFF-side authenticator. Never built from a payload. */
export interface AuthenticatedCaller {
  /** The deploying party (the key owner), not the end user. */
  readonly organization: string
  /** The organization's subject namespace (its identity provider). */
  readonly issuer: string
  /** The end user within that namespace. It becomes a ledger tenant and is never stored as a name. */
  readonly subject: string
  /** An authorization attribute inside the tenant, bound as ADR-23 binds it. */
  readonly scope: string
}

/** The request as an authenticator sees it: read-only, without the body. */
export interface CallerRequest {
  readonly method: string
  readonly path: string
  readonly headers: IncomingHttpHeaders
}

export interface CallerAuthenticator {
  /** The authenticated caller, or `null` when the request carries no valid credential. A throw is treated as the authenticator being down. */
  authenticate(request: CallerRequest): AuthenticatedCaller | null | Promise<AuthenticatedCaller | null>
}

export interface OrganizationKeyring {
  /** The per-organization server-side key (at least 32 bytes), or `null` for an organization this service does not serve. */
  keyFor(organization: string): Uint8Array | null
}

/** A keyring over a fixed set of keys. Key storage and rotation are deployment concerns and are not designed here. */
export class StaticOrganizationKeyring implements OrganizationKeyring {
  private readonly keys = new Map<string, Uint8Array>()

  constructor(keys: Readonly<Record<string, Uint8Array>>) {
    for (const [organization, key] of Object.entries(keys)) {
      assertOrganizationId(organization)
      if (!(key instanceof Uint8Array) || key.byteLength < 32) throw new RangeError(`the key of organization ${organization} must be at least 32 bytes`)
      this.keys.set(organization, Uint8Array.from(key))
    }
  }

  keyFor(organization: string): Uint8Array | null {
    return this.keys.get(organization) ?? null
  }
}

export class SeamError extends TenantStateError {}

/** The authenticated principal cannot be turned into a ledger tenant: an empty, oversized or malformed claim. */
export class InvalidPrincipalError extends SeamError {
  constructor(message: string) {
    super('GOTRY_SEAM_PRINCIPAL_INVALID', message)
  }
}

/** The caller belongs to an organization this service holds no key for. */
export class UnknownOrganizationError extends SeamError {
  constructor() {
    super('GOTRY_SEAM_ORGANIZATION_UNKNOWN', 'the organization is not served here')
  }
}

/** Something other than a `SeamTenant` reached an API that needs one. */
export class SeamTenantRequiredError extends SeamError {
  constructor() {
    super('GOTRY_SEAM_TENANT_REQUIRED', 'a tenant derived at the seam is required')
  }
}

/**
 * The ledger tenant of one authenticated caller. It can be produced only by `deriveSeamTenant`: the brand is a
 * type-level guard and the registry below is the runtime one, so a look-alike object (parsed JSON, a cast) is refused.
 */
export interface SeamTenant {
  readonly organization: string
  readonly ledgerTenant: string
  readonly [seamBrand]: true
}

const issued = new WeakSet<object>()

export function isSeamTenant(value: unknown): value is SeamTenant {
  return typeof value === 'object' && value !== null && issued.has(value)
}

export function assertSeamTenant(value: unknown): SeamTenant {
  if (!isSeamTenant(value)) throw new SeamTenantRequiredError()
  return value
}

/** `<organization>/<ledger tenant>`: the key for every in-process map and every metric. It contains no personal data. */
export function seamTenantKey(tenant: SeamTenant): string {
  return `${assertSeamTenant(tenant).organization}/${tenant.ledgerTenant}`
}

function principalField(name: string, value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) throw new InvalidPrincipalError(`${name} must be a non-empty string`)
  if (value.length > MAX_PRINCIPAL_FIELD_CHARS) throw new InvalidPrincipalError(`${name} must be at most ${MAX_PRINCIPAL_FIELD_CHARS} characters`)
  return value
}

/**
 * The only derivation of a ledger tenant from a caller in the service.
 *
 * @throws InvalidTenantIdError for an organization id that is not path-safe, or an issuer or subject that is not well-formed
 * @throws InvalidPrincipalError for a missing or oversized subject, issuer or scope
 * @throws UnknownOrganizationError when the keyring holds no key for the organization
 */
export function deriveSeamTenant(caller: AuthenticatedCaller, keyring: OrganizationKeyring): SeamTenant {
  if (typeof caller !== 'object' || caller === null) throw new InvalidPrincipalError('the caller must be an object')
  const organization = assertOrganizationId(caller.organization)
  const issuer = principalField('issuer', caller.issuer)
  const subject = principalField('subject', caller.subject)
  principalField('scope', caller.scope)
  const key = keyring.keyFor(organization)
  if (key === null) throw new UnknownOrganizationError()
  const ledgerTenant = deriveLedgerTenantId(key, issuer, subject)
  const tenant = Object.freeze({ organization, ledgerTenant }) as SeamTenant
  issued.add(tenant)
  return tenant
}
