/**
 * Tenant and organization identifiers of the AaaS state layer.
 *
 * A ledger tenant is one end user; an organization is the deploying party
 * (hotelbyte's own vocabulary calls that a "tenant"). The tenant id is derived
 * in the trusted seam from the authenticated principal and is never accepted
 * from payloads, tools or the model. Every filesystem path of the layer is built
 * from ids that passed the validators below and from nothing else (threat S-3).
 */

import { createHmac } from 'node:crypto'
import { join, resolve } from 'node:path'
import { InvalidTenantIdError } from './errors.ts'

const ORGANIZATION_ID = /^[a-z0-9][a-z0-9-]{0,62}$/
const LEDGER_TENANT_ID = /^t-[0-9a-f]{32}$/
const MIN_ORGANIZATION_KEY_BYTES = 32
const MAX_CLAIM_BYTES = 512
const CLAIM_SEPARATOR = Buffer.from([0])

export function assertOrganizationId(value: unknown): string {
  if (typeof value !== 'string' || !ORGANIZATION_ID.test(value)) {
    throw new InvalidTenantIdError('organization id must be 1-63 characters of [a-z0-9-] starting with [a-z0-9]')
  }
  return value
}

export function assertLedgerTenantId(value: unknown): string {
  if (typeof value !== 'string' || !LEDGER_TENANT_ID.test(value)) {
    throw new InvalidTenantIdError('ledger tenant id must be "t-" followed by 32 lowercase hex digits')
  }
  return value
}

function claimBytes(name: string, value: unknown): Buffer {
  if (typeof value !== 'string' || value.length === 0) throw new InvalidTenantIdError(`${name} must be a non-empty string`)
  if (value.includes('\u0000')) throw new InvalidTenantIdError(`${name} must not contain NUL`)
  const bytes = Buffer.from(value, 'utf8')
  // A lone surrogate is replaced by U+FFFD on encoding, and two different subjects would then share one tenant.
  if (bytes.toString('utf8') !== value) throw new InvalidTenantIdError(`${name} must be well-formed Unicode`)
  if (bytes.byteLength > MAX_CLAIM_BYTES) throw new InvalidTenantIdError(`${name} must be at most ${MAX_CLAIM_BYTES} bytes`)
  return bytes
}

/**
 * `t-` + the first 128 bits of HMAC-SHA256(K_org, issuer ‖ 0x00 ‖ subject).
 *
 * `issuer` and `subject` are matched byte for byte as the identity provider
 * issued them; this layer does no Unicode normalization. `organizationKey` is
 * the per-organization server-side key, so ids are neither guessable nor
 * reversible by anyone who only sees a subject.
 */
export function deriveLedgerTenantId(organizationKey: Uint8Array, issuer: string, subject: string): string {
  if (!(organizationKey instanceof Uint8Array) || organizationKey.byteLength < MIN_ORGANIZATION_KEY_BYTES) {
    throw new InvalidTenantIdError(`organization key must be at least ${MIN_ORGANIZATION_KEY_BYTES} bytes`)
  }
  const mac = createHmac('sha256', organizationKey)
    .update(claimBytes('issuer', issuer))
    .update(CLAIM_SEPARATOR)
    .update(claimBytes('subject', subject))
    .digest('hex')
  return `t-${mac.slice(0, 32)}`
}

/** The lease key of one tenant: `<organization>/<ledger tenant>`. */
export function leaseKeyFor(organizationId: string, ledgerTenantId: string): string {
  return `${assertOrganizationId(organizationId)}/${assertLedgerTenantId(ledgerTenantId)}`
}

/**
 * The ownership and replication unit of one tenant on a replica. The directory
 * holds a complete state root (`gotry-state/gotry-state.db` plus planner files),
 * so the existing `openDb(root, ledgerTenantId)` opens it unchanged.
 */
export function tenantRootFor(stateRoot: string, organizationId: string, ledgerTenantId: string): string {
  return join(resolve(stateRoot), 'orgs', assertOrganizationId(organizationId), 'tenants', assertLedgerTenantId(ledgerTenantId))
}
