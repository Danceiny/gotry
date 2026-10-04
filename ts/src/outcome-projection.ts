/**
 * Outcome ↔ planning-estimate projection contract v1 (issue #340 contract slice,
 * SIMULATED-TRIGGER DRILL — default OFF, zero callers, trigger flag frozen false).
 *
 * ⚠ Evidence boundary (read this before citing anything from this module):
 * this is `fixture_contract` machinery exercised by a `simulated_trigger_drill`.
 * #340's real trigger ("supplier protocol + WriteGate admission + authorized real
 * order/refund authority facts") has NOT fired. Nothing here is, or may be cited
 * as, real-order evidence; `OUTCOME_TRIGGER_FIRED` stays false and the tracker
 * stays open. Fixtures are derived read-only from the hotelbyte fake-CLI outcome
 * vocabulary (ts/scripts/hotelbyte-spawn-e2e-tests.ts); no real CLI, network,
 * subprocess, credential or ledger surface is touched.
 *
 * Shape (mirrors ts/capabilities/fx-contract.ts #344 and ts/src/session-zones.ts P4-1):
 *  - pure functions, zero IO / timers / network; every clock is injected;
 *  - closed error-code set (`OutcomeErrorCode`), typed results, fail-closed;
 *  - the real-order ingestion seam is interface + data shape only
 *    (`ingestSupplierOutcome` refuses with `trigger_deferred` before reading any
 *    source, so zero supplier records are consulted before the trigger fires).
 *
 * Frozen upstream vocabulary (READ-ONLY reuse, nothing re-declared):
 *  - docs/design/write-gate-production-design.md §3 SupplierOutcome / §7 unknown
 *    reconciliation / §8 cancel ≠ refund, cancel.serviceFee ≠ customer refund,
 *    pending → compensated cancels only the local suggestion;
 *  - ts/src/booking-surface/cancel-refund-commission.ts (#233): refund authority
 *    sources, `SERVICE_FEE_SOURCE`, and the local ledger alphabet whose
 *    `compensated` word is explicitly NOT a supplier outcome;
 *  - ts/capabilities/hotelbyte-transaction.ts (#232): attempt / customerReferenceNo
 *    binding keys and the "unknown is never success" discipline;
 *  - ts/capabilities/fx-contract.ts (#344): Money / NormalizedAmount, single
 *    valuation instant comparison — an FX rate is never guessed here either.
 *
 * Red lines encoded structurally (each has a falsification test in
 * ts/scripts/outcome-projection-tests.ts, run-all §85):
 *  1. association: plan estimate ↔ immutable quote ↔ supplier attempt bind by four
 *     mandatory keys; a missing key is refused, never defaulted;
 *  2. `unknown` / `pending` are never settled success and never zero deviation —
 *     they are counted as `indeterminate`, separately from any sample;
 *  3. append-only + revocable: nothing is mutated or deleted; a revocation is
 *     itself an entry; replay of an idempotency key is a no-op, a key reused with
 *     a different payload is a conflict;
 *  4. terminal states never regress (terminal → open refused; terminal → a
 *     non-progressive terminal refused), while a LATE terminal observation is
 *     accepted and flagged;
 *  5. negative list: sensitive order fields and credentials can never enter the
 *     projection — the evidence record is key-allow-listed AND value-scanned;
 *  6. deviation may only calibrate FUTURE estimates/ranking, within declared
 *     bounds, with an explanation; it can NEVER enter the user's hard budget
 *     verdict (`hardBudgetVerdict` admits only an `AuthoritativeTotal`).
 *
 * Out of scope by construction (only the real trigger can supply it): a real-order
 * E2E, real deviation distributions, any calibration constant justified by data,
 * and admission of the ingestion seam.
 *
 * @module src/outcome-projection
 */

import { makeFactId } from './bookable-facts.ts'
import {
  REFUND_AUTHORITY_SOURCES,
  SERVICE_FEE_SOURCE,
  LOCAL_LEDGER_STATUSES,
} from './booking-surface/cancel-refund-commission.ts'
import {
  compareMoney,
  formatMoney,
  type MoneyAmount,
  type NormalizedAmount,
} from '../capabilities/fx-contract.ts'

/** Versioned contract schema id (readers validate it). */
export const OUTCOME_PROJECTION_SCHEMA = 'gotry_outcome_projection.v1'
export const OUTCOME_CALIBRATION_SCHEMA = 'gotry_outcome_calibration.v1'

/**
 * #340 implementation trigger gate, frozen false. Flipping it true requires the
 * supplier protocol + WriteGate production admission + authorized real order /
 * refund authority facts (issue #340 启动条件). Fixtures, model self-reports and
 * "booking attempts" explicitly do not count.
 */
export const OUTCOME_TRIGGER_FIRED = false

/** Bounded projection: an unbounded outcome log is a memory-face defect, not a fact. */
export const MAX_PROJECTION_ENTRIES = 256
/** Bounded free text: a reason/explanation is a label, never a transcript. */
export const MAX_REASON_CHARS = 200

// ---------------------------------------------------------------------------
// 1. Closed sets and typed results
// ---------------------------------------------------------------------------

/** Closed error-code set; every refusal carries evidence in `detail`. */
export type OutcomeErrorCode =
  /** a mandatory association / binding key is missing or blank */
  | 'binding_incomplete'
  /** value outside a closed set (status, evidence kind, entry kind) */
  | 'closed_set'
  /** a LOCAL ledger word (e.g. `compensated`) offered as a supplier outcome */
  | 'local_ledger_status_not_supplier_outcome'
  /** timestamp missing / unparseable / postdating the injected clock */
  | 'bad_ts'
  /** sensitive order field or credential shape offered to the projection */
  | 'negative_list'
  /** terminal `refunded` claimed without an authoritative refund record */
  | 'evidence_required'
  /** the cancel service fee offered as the customer refund amount */
  | 'service_fee_as_refund'
  /** terminal → open: information regression */
  | 'terminal_regression'
  /** terminal → a terminal the frozen lifecycle does not reach */
  | 'terminal_conflict'
  /** same idempotency key, different payload */
  | 'idempotency_conflict'
  /** status is structurally not comparable (unknown/pending: never zero deviation) */
  | 'not_comparable'
  /** two sides of a comparison do not share one declared valuation instant/currency */
  | 'mixed_valuation_basis'
  /** referenced entry does not exist, or is already revoked */
  | 'unknown_entry'
  /** a declared bound (entries, text length, modifier range) is exceeded */
  | 'bound_exceeded'
  /** the real-order ingestion seam refuses before reading any source */
  | 'trigger_deferred'
  /** a non-authoritative (e.g. calibrated) amount offered to the hard budget verdict */
  | 'hard_budget_guard'

export type OutcomeResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: OutcomeErrorCode; detail: string }

function fail<T>(code: OutcomeErrorCode, detail: string): OutcomeResult<T> {
  return { ok: false, code, detail }
}
function pass<T>(value: T): OutcomeResult<T> {
  return { ok: true, value }
}

/**
 * Supplier final outcome alphabet (write-gate-production-design §3 subset plus the
 * mandatory `unknown`). `unknown` exists precisely so that a timeout / killed
 * process / unparseable response has a home that is neither success nor failure.
 */
export const OUTCOME_STATUSES = ['pending', 'confirmed', 'failed', 'cancelled', 'refunded', 'unknown'] as const
export type OutcomeStatus = (typeof OUTCOME_STATUSES)[number]

/** Open (non-terminal) statuses: no settlement conclusion may be drawn from them. */
export const OPEN_OUTCOME_STATUSES = ['pending', 'unknown'] as const
/** Terminal statuses: a terminal never regresses to an open status. */
export const TERMINAL_OUTCOME_STATUSES = ['confirmed', 'failed', 'cancelled', 'refunded'] as const
export type TerminalOutcomeStatus = (typeof TERMINAL_OUTCOME_STATUSES)[number]

export function isOutcomeStatus(v: unknown): v is OutcomeStatus {
  return typeof v === 'string' && (OUTCOME_STATUSES as readonly string[]).includes(v)
}
export function isTerminalOutcomeStatus(v: unknown): v is TerminalOutcomeStatus {
  return typeof v === 'string' && (TERMINAL_OUTCOME_STATUSES as readonly string[]).includes(v)
}
export function statusTerminality(status: OutcomeStatus): 'open' | 'terminal' {
  return isTerminalOutcomeStatus(status) ? 'terminal' : 'open'
}

/**
 * Settled SUCCESS is `confirmed` and nothing else. In particular `unknown` (the
 * timeout / indeterminate bucket) is never a sale — #340 acceptance 2.
 */
export function countsAsSettledSuccess(status: OutcomeStatus): boolean {
  return status === 'confirmed'
}

/**
 * Deviation comparability. Only `confirmed` pairs a planning estimate with a
 * supplier final charge. `pending`/`unknown` are indeterminate (never zero
 * deviation); `failed`/`cancelled`/`refunded` have no comparable final charge —
 * their money face is the independent aftercare surface of #233.
 */
export function comparableForDeviation(status: OutcomeStatus): boolean {
  return status === 'confirmed'
}

/** Frozen terminal lifecycle DAG: which terminal may follow which terminal. */
export const TERMINAL_PROGRESSIONS: Readonly<Record<TerminalOutcomeStatus, readonly TerminalOutcomeStatus[]>> = {
  confirmed: ['cancelled', 'refunded'],
  cancelled: ['refunded'],
  failed: [],
  refunded: [],
}

/**
 * Transition admission. `idempotent` = the same status re-observed (a replay of
 * the world, not of the key). Terminal → open and terminal → unreachable terminal
 * are refused with evidence; an open → terminal arriving late is `progress`.
 */
export function transitionAllowed(from: OutcomeStatus, to: OutcomeStatus): OutcomeResult<'progress' | 'idempotent'> {
  if (!isOutcomeStatus(from) || !isOutcomeStatus(to)) {
    return fail('closed_set', `transition endpoints must be in [${OUTCOME_STATUSES.join('/')}], got ${JSON.stringify(from)}→${JSON.stringify(to)}`)
  }
  if (from === to) return pass('idempotent')
  if (statusTerminality(from) === 'open') return pass('progress')
  if (statusTerminality(to) === 'open') {
    return fail(
      'terminal_regression',
      `terminal ${from} must not regress to open ${to} — a later probe failure is not evidence that a settled outcome unsettled (write-gate §7: 终态后反证只置冲突交人工)`,
    )
  }
  const reachable = TERMINAL_PROGRESSIONS[from as TerminalOutcomeStatus]
  if (reachable.includes(to as TerminalOutcomeStatus)) return pass('progress')
  return fail(
    'terminal_conflict',
    `terminal ${from} does not reach terminal ${to} in the frozen lifecycle (reachable: [${reachable.join('/') || 'none'}]) — explicit conflict for human reconciliation, never a silent flip`,
  )
}

// ---------------------------------------------------------------------------
// 2. Association key: plan estimate ↔ immutable quote ↔ supplier attempt
// ---------------------------------------------------------------------------

/**
 * The four mandatory binding keys (#340 acceptance 1). None is derivable from
 * another: a projection without all four is an untraceable black hole and is
 * refused. `projectionKey` is their stable deterministic derivation.
 */
export interface OutcomeAssociationKey {
  /** the planning estimate this projection calibrates against */
  readonly planEstimateId: string
  /** the immutable quote (frozen price/currency) the estimate was priced from */
  readonly quoteId: string
  /** the immutable write attempt (#232 attemptId; never re-derived) */
  readonly attemptId: string
  /** the ledger intent idempotency key (#231 产物; placeholder until #231 lands) */
  readonly intentIdemKey: string
  /** deterministic, stable association id */
  readonly projectionKey: string
}

function requiredKey(label: string, value: unknown): OutcomeResult<string> {
  if (typeof value !== 'string' || value.trim() === '') {
    return fail('binding_incomplete', `association key ${label} must be a non-empty string, got ${JSON.stringify(value)} (no default, no derivation from a sibling key)`)
  }
  return pass(value.trim())
}

export function associationKey(input: {
  planEstimateId: unknown
  quoteId: unknown
  attemptId: unknown
  intentIdemKey: unknown
}): OutcomeResult<OutcomeAssociationKey> {
  const plan = requiredKey('planEstimateId', input?.planEstimateId)
  if (!plan.ok) return plan
  const quote = requiredKey('quoteId', input?.quoteId)
  if (!quote.ok) return quote
  const attempt = requiredKey('attemptId', input?.attemptId)
  if (!attempt.ok) return attempt
  const intent = requiredKey('intentIdemKey', input?.intentIdemKey)
  if (!intent.ok) return intent
  return pass(Object.freeze({
    planEstimateId: plan.value,
    quoteId: quote.value,
    attemptId: attempt.value,
    intentIdemKey: intent.value,
    projectionKey: makeFactId(['outcome-projection', plan.value, quote.value, attempt.value, intent.value]),
  }))
}

// ---------------------------------------------------------------------------
// 3. Time basis and the negative list
// ---------------------------------------------------------------------------

/** UTC instant parse + normalization (fx-contract discipline: date-only is not an instant). */
export function parseObservationInstant(value: unknown, label: string): OutcomeResult<string> {
  if (typeof value !== 'string' || value.trim() === '') {
    return fail('bad_ts', `${label} must be a non-empty ISO-8601 UTC instant, got ${JSON.stringify(value)}`)
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(value.trim())) {
    return fail('bad_ts', `${label} must carry a full time-of-day (date-only '${value}' cannot order observations)`)
  }
  const ms = Date.parse(value)
  if (!Number.isFinite(ms)) return fail('bad_ts', `${label} is not a parseable ISO-8601 instant: ${JSON.stringify(value)}`)
  return pass(new Date(ms).toISOString())
}

/**
 * Evidence key allow-list (closed set). Anything else — including a field that
 * merely looks harmless — is refused: the projection carries digests and pointers,
 * never order payloads. Shape discipline mirrors session-zones' write-side list.
 */
export const OUTCOME_EVIDENCE_ALLOWED_KEYS = [
  'supplier_status_word',
  'supplier_order_ref_digest',
  'customer_reference_digest',
  'probe_digest',
  'request_fingerprint_sha256',
  'approval_receipt_digest',
  'refund_evidence_kind',
  'refund_evidence_digest',
  'amount_source',
  'classification',
] as const
export type OutcomeEvidenceKey = (typeof OUTCOME_EVIDENCE_ALLOWED_KEYS)[number]

/** Explicitly named forbidden keys, reported by name so the refusal is actionable. */
export const OUTCOME_EVIDENCE_FORBIDDEN_KEYS = [
  'guest_name', 'guestName', 'passenger_name', 'passengerName', 'contact_name',
  'passport', 'passport_no', 'id_card', 'idCard', 'national_id',
  'phone', 'mobile', 'email', 'address', 'postal_code',
  'card_number', 'cardNumber', 'pan', 'cvv', 'expiry',
  'password', 'api_key', 'apiKey', 'secret', 'token', 'authorization', 'cookie',
  'raw_payload', 'rawPayload', 'raw_response', 'rawResponse', 'stdout', 'stderr',
] as const

/** Value-shape scan (defense in depth behind the key allow-list). */
const OUTCOME_VALUE_NEGATIVE_PATTERNS: Array<{ re: RegExp; label: string }> = [
  { re: /\d{15,17}[Xx]?/, label: 'suspected document/card number' },
  { re: /1[3-9]\d{9}/, label: 'suspected mainland mobile number' },
  { re: /(护照|身份证|证件号|通行证)\s*号?\s*[:：]?\s*\w+/i, label: 'identity document field' },
  { re: /[\w.+-]+@[\w-]+\.[\w.-]+/, label: 'email address' },
  { re: /https?:\/\/\S+/i, label: 'URL' },
  { re: /(?:api[_-]?key|secret|token|password|passwd)\s*[:=]\s*\S+/i, label: 'credential shape' },
  { re: /\bbearer\s+[A-Za-z0-9._-]{8,}/i, label: 'credential shape' },
  { re: /\bsk-[A-Za-z0-9]{12,}/, label: 'credential shape' },
]

/** Deterministic canonical JSON (sorted keys); cycles / depth / undefined → null. */
export function canonicalOutcomeJson(v: unknown, depth = 0, seen: Set<object> = new Set()): string | null {
  if (v === undefined || typeof v === 'function') return null
  if (typeof v === 'bigint') return JSON.stringify(v.toString())
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null'
  if (depth > 5 || seen.has(v)) return null
  seen.add(v)
  if (Array.isArray(v)) {
    const parts: string[] = []
    for (const x of v) {
      const p = canonicalOutcomeJson(x, depth + 1, seen)
      if (p === null) return null
      parts.push(p)
    }
    return `[${parts.join(',')}]`
  }
  const obj = v as Record<string, unknown>
  const parts: string[] = []
  for (const k of Object.keys(obj).sort()) {
    const p = canonicalOutcomeJson(obj[k], depth + 1, seen)
    if (p === null) return null
    parts.push(`${JSON.stringify(k)}:${p}`)
  }
  return `{${parts.join(',')}}`
}

/**
 * Negative-list gate for the evidence record. Returns a refusal reason, or null.
 * Order matters for diagnosability: a named forbidden key is reported as such
 * before the generic "not in the allow-list" message.
 */
export function outcomeEvidenceViolation(evidence: unknown): string | null {
  if (evidence === null || typeof evidence !== 'object' || Array.isArray(evidence)) {
    return 'evidence must be a plain object of allow-listed digest/pointer fields'
  }
  const record = evidence as Record<string, unknown>
  for (const key of Object.keys(record)) {
    if ((OUTCOME_EVIDENCE_FORBIDDEN_KEYS as readonly string[]).includes(key)) {
      return `negative list: sensitive order field '${key}' never enters the projection (digests and pointers only)`
    }
    if (!(OUTCOME_EVIDENCE_ALLOWED_KEYS as readonly string[]).includes(key)) {
      return `negative list: key '${key}' is not in the evidence allow-list [${OUTCOME_EVIDENCE_ALLOWED_KEYS.join('/')}] — extend the closed set via PR, never by passing data through`
    }
  }
  const canonical = canonicalOutcomeJson(record)
  if (canonical === null) return 'evidence must be finite, acyclic, bounded-depth and free of undefined values'
  for (const { re, label } of OUTCOME_VALUE_NEGATIVE_PATTERNS) {
    if (re.test(canonical)) return `negative list: ${label} detected in an evidence value (digests and pointers only)`
  }
  return null
}

// ---------------------------------------------------------------------------
// 4. Append-only, revocable projection
// ---------------------------------------------------------------------------

export const PROJECTION_ENTRY_KINDS = ['outcome_observed', 'revocation'] as const
export type ProjectionEntryKind = (typeof PROJECTION_ENTRY_KINDS)[number]

/** Amount carried as a decimal-string minor unit so entries stay JSON-deterministic. */
export interface ProjectionAmount {
  readonly currency: string
  readonly amount_minor: string
  /** where the number is authoritative from; a refund amount may never be the cancel service fee */
  readonly source: string
}

export interface ProjectionEntry {
  readonly schema: typeof OUTCOME_PROJECTION_SCHEMA
  readonly entry_id: string
  readonly seq: number
  readonly kind: ProjectionEntryKind
  readonly idem_key: string
  /** supplier observation time (may predate the previous entry: a LATE terminal) */
  readonly observed_at: string
  /** host append time (injected clock) */
  readonly appended_at: string
  readonly payload_digest: string
  readonly status?: OutcomeStatus
  readonly amount?: ProjectionAmount
  readonly evidence?: Readonly<Record<string, unknown>>
  /** revocation only: the entry_id withdrawn (the original is never deleted) */
  readonly revokes?: string
  readonly reason?: string
}

export interface OutcomeProjection {
  readonly schema: typeof OUTCOME_PROJECTION_SCHEMA
  readonly key: OutcomeAssociationKey
  readonly entries: readonly ProjectionEntry[]
}

export function emptyProjection(key: OutcomeAssociationKey): OutcomeProjection {
  return Object.freeze({ schema: OUTCOME_PROJECTION_SCHEMA, key, entries: Object.freeze([]) as readonly ProjectionEntry[] })
}

/** One supplier observation offered to the projection. */
export interface OutcomeObservation {
  readonly idemKey: unknown
  readonly status: unknown
  readonly observedAt: unknown
  /** supplier final amount (confirmed) or the authoritative aftercare amount */
  readonly amount?: { readonly money: MoneyAmount; readonly source: string }
  readonly evidence?: unknown
  readonly reason?: unknown
}

export interface AppendOutcomeOk {
  readonly projection: OutcomeProjection
  /** false = idempotent replay of the same key + payload; zero new entries */
  readonly appended: boolean
  readonly entry?: ProjectionEntry
  /** true when this observation's observed_at predates the previous effective one */
  readonly lateObservation: boolean
  readonly transition: 'progress' | 'idempotent'
}

function boundedText(label: string, value: unknown): OutcomeResult<string | undefined> {
  if (value === undefined) return pass(undefined)
  if (typeof value !== 'string') return fail('closed_set', `${label} must be a string when present, got ${JSON.stringify(value)}`)
  if (value.length > MAX_REASON_CHARS) return fail('bound_exceeded', `${label} exceeds ${MAX_REASON_CHARS} chars (${value.length}) — a label, never a transcript`)
  return pass(value)
}

function amountOf(observation: OutcomeObservation, status: OutcomeStatus): OutcomeResult<ProjectionAmount | undefined> {
  const amount = observation.amount
  if (amount === undefined) {
    if (status === 'refunded') {
      return fail('evidence_required', 'terminal refunded requires an authoritative refund amount (#233: refunded only from supplier/wallet refund records)')
    }
    return pass(undefined)
  }
  const money = amount.money
  if (money === null || typeof money !== 'object' || typeof money.currency !== 'string' || typeof money.amountMinor !== 'bigint') {
    return fail('closed_set', 'amount.money must be an fx-contract MoneyAmount (currency + bigint minor unit); floats are refused')
  }
  if (typeof amount.source !== 'string' || amount.source.trim() === '') {
    return fail('binding_incomplete', 'amount.source must name where the number is authoritative from')
  }
  if (status === 'refunded') {
    if (amount.source === SERVICE_FEE_SOURCE) {
      return fail('service_fee_as_refund', `the supplier cancel service fee (${SERVICE_FEE_SOURCE}) is a separate disclosure and is never the customer refund amount (#233 / write-gate §8)`)
    }
    if (!(REFUND_AUTHORITY_SOURCES as readonly string[]).includes(amount.source)) {
      return fail('evidence_required', `refund amount source must be one of [${REFUND_AUTHORITY_SOURCES.join('/')}], got ${JSON.stringify(amount.source)}`)
    }
  }
  return pass({ currency: money.currency, amount_minor: money.amountMinor.toString(), source: amount.source })
}

/**
 * Append one supplier observation (pure; returns a new projection).
 *
 * Guards, in order: trigger-independent shape → closed status set → local ledger
 * word rejection → clock sanity → negative list → idempotency → transition.
 */
export function appendOutcome(
  projection: OutcomeProjection,
  observation: OutcomeObservation,
  now: string,
): OutcomeResult<AppendOutcomeOk> {
  if (projection?.schema !== OUTCOME_PROJECTION_SCHEMA) {
    return fail('closed_set', `projection schema must be ${OUTCOME_PROJECTION_SCHEMA}`)
  }
  if (projection.entries.length >= MAX_PROJECTION_ENTRIES) {
    return fail('bound_exceeded', `projection already holds ${projection.entries.length} entries (bound ${MAX_PROJECTION_ENTRIES}); an unbounded outcome log is a defect`)
  }
  const nowParsed = parseObservationInstant(now, 'injected clock now')
  if (!nowParsed.ok) return nowParsed

  if (typeof observation?.status === 'string' && (LOCAL_LEDGER_STATUSES as readonly string[]).includes(observation.status) && !isOutcomeStatus(observation.status)) {
    return fail(
      'local_ledger_status_not_supplier_outcome',
      `'${observation.status}' is a LOCAL ledger word (ADR-17 alphabet [${LOCAL_LEDGER_STATUSES.join('/')}]): compensating a local suggestion is not a supplier outcome and never means refunded (write-gate §8)`,
    )
  }
  if (!isOutcomeStatus(observation?.status)) {
    return fail('closed_set', `outcome status must be one of [${OUTCOME_STATUSES.join('/')}], got ${JSON.stringify(observation?.status)}`)
  }
  const status: OutcomeStatus = observation.status

  const idem = requiredKey('idemKey', observation.idemKey)
  if (!idem.ok) return fail('binding_incomplete', idem.detail)
  const observedAt = parseObservationInstant(observation.observedAt, 'observation observed_at')
  if (!observedAt.ok) return observedAt
  if (observedAt.value > nowParsed.value) {
    return fail('bad_ts', `observed_at ${observedAt.value} postdates the injected clock ${nowParsed.value} — impossible provenance`)
  }

  const reason = boundedText('reason', observation.reason)
  if (!reason.ok) return reason

  const evidence = observation.evidence ?? {}
  const violation = outcomeEvidenceViolation(evidence)
  if (violation !== null) return fail('negative_list', violation)

  const amount = amountOf(observation, status)
  if (!amount.ok) return amount

  const payloadDigest = makeFactId([
    'outcome-observed',
    status,
    observedAt.value,
    amount.value ? `${amount.value.currency}:${amount.value.amount_minor}:${amount.value.source}` : '',
    canonicalOutcomeJson(evidence) ?? '',
    reason.value ?? '',
  ])

  const prior = projection.entries.find(e => e.idem_key === idem.value)
  if (prior !== undefined) {
    if (prior.payload_digest === payloadDigest) {
      return pass({ projection, appended: false, lateObservation: false, transition: 'idempotent' })
    }
    return fail(
      'idempotency_conflict',
      `idempotency key ${idem.value} already carries payload ${prior.payload_digest} (seq ${prior.seq}); a different payload ${payloadDigest} under the same key is a conflict, never an overwrite`,
    )
  }

  const view = foldProjection(projection)
  const from: OutcomeStatus = view.status ?? 'unknown'
  const transition = view.status === null ? pass<'progress' | 'idempotent'>('progress') : transitionAllowed(from, status)
  if (!transition.ok) return transition

  const seq = projection.entries.length
  const entry: ProjectionEntry = Object.freeze({
    schema: OUTCOME_PROJECTION_SCHEMA,
    entry_id: makeFactId([projection.key.projectionKey, String(seq), payloadDigest]),
    seq,
    kind: 'outcome_observed' as ProjectionEntryKind,
    idem_key: idem.value,
    observed_at: observedAt.value,
    appended_at: nowParsed.value,
    payload_digest: payloadDigest,
    status,
    ...(amount.value !== undefined ? { amount: amount.value } : {}),
    evidence: Object.freeze({ ...(evidence as Record<string, unknown>) }),
    ...(reason.value !== undefined ? { reason: reason.value } : {}),
  })
  const lateObservation = view.lastObservedAt !== null && observedAt.value < view.lastObservedAt
  return pass({
    projection: Object.freeze({ ...projection, entries: Object.freeze([...projection.entries, entry]) as readonly ProjectionEntry[] }),
    appended: true,
    entry,
    lateObservation,
    transition: transition.value,
  })
}

/**
 * Revoke one entry (append-only: a revocation is itself an entry; nothing is
 * deleted or mutated). A revocation needs its own idempotency key, a bounded
 * reason and an actor; revoking a missing or already-revoked entry is refused.
 */
export function revokeEntry(
  projection: OutcomeProjection,
  input: { targetEntryId: unknown; reason: unknown; actor: unknown; idemKey: unknown },
  now: string,
): OutcomeResult<{ projection: OutcomeProjection; entry: ProjectionEntry }> {
  if (projection.entries.length >= MAX_PROJECTION_ENTRIES) {
    return fail('bound_exceeded', `projection already holds ${projection.entries.length} entries (bound ${MAX_PROJECTION_ENTRIES})`)
  }
  const nowParsed = parseObservationInstant(now, 'injected clock now')
  if (!nowParsed.ok) return nowParsed
  const target = requiredKey('targetEntryId', input?.targetEntryId)
  if (!target.ok) return fail('binding_incomplete', target.detail)
  const actor = requiredKey('actor', input?.actor)
  if (!actor.ok) return fail('binding_incomplete', actor.detail)
  const idem = requiredKey('idemKey', input?.idemKey)
  if (!idem.ok) return fail('binding_incomplete', idem.detail)
  const reasonText = requiredKey('reason', input?.reason)
  if (!reasonText.ok) return fail('binding_incomplete', `${reasonText.detail} (a revocation without a stated reason is not auditable)`)
  const reason = boundedText('reason', reasonText.value)
  if (!reason.ok) return reason

  const observed = projection.entries.find(e => e.entry_id === target.value && e.kind === 'outcome_observed')
  if (observed === undefined) {
    return fail('unknown_entry', `no observed entry ${target.value} in projection ${projection.key.projectionKey}`)
  }
  if (projection.entries.some(e => e.kind === 'revocation' && e.revokes === target.value)) {
    return fail('unknown_entry', `entry ${target.value} is already revoked; a second revocation is not an additional fact`)
  }
  if (projection.entries.some(e => e.idem_key === idem.value)) {
    return fail('idempotency_conflict', `idempotency key ${idem.value} is already used in this projection`)
  }

  const seq = projection.entries.length
  const payloadDigest = makeFactId(['revocation', target.value, actor.value, reason.value ?? ''])
  const entry: ProjectionEntry = Object.freeze({
    schema: OUTCOME_PROJECTION_SCHEMA,
    entry_id: makeFactId([projection.key.projectionKey, String(seq), payloadDigest]),
    seq,
    kind: 'revocation' as ProjectionEntryKind,
    idem_key: idem.value,
    observed_at: nowParsed.value,
    appended_at: nowParsed.value,
    payload_digest: payloadDigest,
    revokes: target.value,
    reason: `${actor.value}: ${reason.value ?? ''}`.slice(0, MAX_REASON_CHARS),
  })
  return pass({
    projection: Object.freeze({ ...projection, entries: Object.freeze([...projection.entries, entry]) as readonly ProjectionEntry[] }),
    entry,
  })
}

export interface ProjectionView {
  /** null = no effective observation yet (never defaulted to a status) */
  readonly status: OutcomeStatus | null
  readonly terminal: boolean
  readonly settledSuccess: boolean
  /** true while the current status carries no settlement conclusion */
  readonly indeterminate: boolean
  readonly lastObservedAt: string | null
  readonly effectiveEntryIds: readonly string[]
  readonly revokedEntryIds: readonly string[]
  /** entries whose transition was refused during a deterministic re-fold (should stay empty) */
  readonly foldConflicts: readonly string[]
}

/**
 * Deterministic fold: entries in append order, revoked observations skipped.
 * Re-folding a projection always reproduces the same view (replay == direct read).
 */
export function foldProjection(projection: OutcomeProjection): ProjectionView {
  const revoked = new Set<string>()
  for (const e of projection.entries) {
    if (e.kind === 'revocation' && typeof e.revokes === 'string') revoked.add(e.revokes)
  }
  let status: OutcomeStatus | null = null
  let lastObservedAt: string | null = null
  const effective: string[] = []
  const conflicts: string[] = []
  for (const e of projection.entries) {
    if (e.kind !== 'outcome_observed' || e.status === undefined) continue
    if (revoked.has(e.entry_id)) continue
    if (status !== null) {
      const t = transitionAllowed(status, e.status)
      if (!t.ok) {
        conflicts.push(e.entry_id)
        continue
      }
    }
    status = e.status
    lastObservedAt = e.observed_at
    effective.push(e.entry_id)
  }
  return Object.freeze({
    status,
    terminal: status !== null && statusTerminality(status) === 'terminal',
    settledSuccess: status !== null && countsAsSettledSuccess(status),
    indeterminate: status === null || statusTerminality(status) === 'open',
    lastObservedAt,
    effectiveEntryIds: Object.freeze([...effective]) as readonly string[],
    revokedEntryIds: Object.freeze([...revoked]) as readonly string[],
    foldConflicts: Object.freeze([...conflicts]) as readonly string[],
  })
}

// ---------------------------------------------------------------------------
// 5. Deviation (single declared valuation instant; never a guessed FX rate)
// ---------------------------------------------------------------------------

export interface DeviationBasis {
  /** the planning estimate, normalized and pinned to the declared comparison instant */
  readonly estimate: NormalizedAmount
  /** the supplier final charge, normalized and pinned to the SAME instant */
  readonly actual: NormalizedAmount
}

export interface Deviation {
  readonly currency: string
  /** actual − estimate, in minor units of the comparison currency */
  readonly deltaMinor: bigint
  readonly estimateMinor: bigint
  readonly actualMinor: bigint
  readonly direction: 'over' | 'under' | 'exact'
  /** the single declared valuation instant both sides were pinned to */
  readonly valuationAsOf: string
  readonly projectionKey: string
  readonly basisEntryIds: readonly string[]
  readonly explanation: string
}

/**
 * Deviation of a confirmed outcome against its planning estimate.
 *
 * Refuses (never returns zero) when the folded status is not `confirmed` — in
 * particular `unknown`/`pending` yield `not_comparable`, never 0. Both sides must
 * already be normalized to one currency at ONE valuation instant: the mixed-basis
 * refusal is delegated to fx-contract's `compareMoney`, so no FX rate is invented.
 */
export function deviationOf(projection: OutcomeProjection, basis: DeviationBasis): OutcomeResult<Deviation> {
  const view = foldProjection(projection)
  if (view.status === null) {
    return fail('not_comparable', `projection ${projection.key.projectionKey} has no effective observation — absence of an outcome is not a zero deviation`)
  }
  if (!comparableForDeviation(view.status)) {
    const why = statusTerminality(view.status) === 'open'
      ? 'an indeterminate outcome (timeout/unknown/pending) is never a sale and never a zero deviation (#340 acceptance 2)'
      : 'only a confirmed outcome pairs an estimate with a supplier final charge; failed/cancelled/refunded money belongs to the independent aftercare surface (#233)'
    return fail('not_comparable', `folded status ${view.status} is not comparable: ${why}`)
  }
  try {
    compareMoney(basis.estimate, basis.actual)
  } catch (e) {
    return fail('mixed_valuation_basis', `estimate and actual must share one normalized currency and one valuation instant: ${e instanceof Error ? e.message : String(e)}`)
  }
  const deltaMinor = basis.actual.amountMinor - basis.estimate.amountMinor
  return pass(Object.freeze({
    currency: basis.actual.currency as string,
    deltaMinor,
    estimateMinor: basis.estimate.amountMinor,
    actualMinor: basis.actual.amountMinor,
    direction: deltaMinor > 0n ? 'over' : deltaMinor < 0n ? 'under' : 'exact',
    valuationAsOf: basis.actual.valuationAsOf,
    projectionKey: projection.key.projectionKey,
    basisEntryIds: view.effectiveEntryIds,
    explanation: `confirmed outcome ${formatMoney({ currency: basis.actual.currency, amountMinor: basis.actual.amountMinor })} vs plan estimate ${formatMoney({ currency: basis.estimate.currency, amountMinor: basis.estimate.amountMinor })} at valuation instant ${basis.actual.valuationAsOf}`,
  }))
}

// ---------------------------------------------------------------------------
// 6. Calibration: ranking/future estimates only, never the hard budget
// ---------------------------------------------------------------------------

/** Declared calibration bounds (ppm; 1_000_000 = neutral ×1.0). Not data-derived. */
export const CALIBRATION_MODIFIER_PPM_NEUTRAL = 1_000_000
export const CALIBRATION_MODIFIER_PPM_MIN = 800_000
export const CALIBRATION_MODIFIER_PPM_MAX = 1_250_000
/** Minimum comparable sample before any non-neutral modifier is produced. */
export const CALIBRATION_MIN_SAMPLE = 3

export interface CalibrationAdvice {
  readonly schema: typeof OUTCOME_CALIBRATION_SCHEMA
  /** the ONLY admitted application surface */
  readonly appliesTo: 'ranking_and_future_estimate_display'
  readonly modifierPpm: number
  readonly sampleCount: number
  /** indeterminate outcomes counted separately — never folded in as zero deviation */
  readonly indeterminateCount: number
  readonly explanation: string
  readonly basisProjectionKeys: readonly string[]
  /** type-level literal: this object can never be a hard-budget input */
  readonly admissibleForHardBudget: false
}

/** One projection's contribution to a calibration sample. */
export interface CalibrationInput {
  readonly projection: OutcomeProjection
  readonly basis?: DeviationBasis
}

/**
 * Build calibration advice from comparable deviations.
 *
 * Indeterminate and non-comparable projections are COUNTED, never valued: they
 * raise `indeterminateCount` and are excluded from the ratio. Below
 * `CALIBRATION_MIN_SAMPLE` the advice is neutral (×1.0) with that stated reason —
 * a thin sample is not evidence. The modifier is always clamped into the declared
 * bounds, and the result is explicitly inadmissible for the hard budget.
 */
export function calibrationFromDeviations(inputs: readonly CalibrationInput[]): OutcomeResult<CalibrationAdvice> {
  let estimateTotal = 0n
  let actualTotal = 0n
  let sampleCount = 0
  let indeterminateCount = 0
  let currency: string | null = null
  const basisKeys: string[] = []
  for (const input of inputs) {
    if (input.basis === undefined) {
      indeterminateCount++
      continue
    }
    const deviation = deviationOf(input.projection, input.basis)
    if (!deviation.ok) {
      if (deviation.code === 'not_comparable') {
        indeterminateCount++
        continue
      }
      return fail(deviation.code, deviation.detail)
    }
    if (currency === null) currency = deviation.value.currency
    else if (currency !== deviation.value.currency) {
      return fail('mixed_valuation_basis', `calibration samples mix currencies (${currency} vs ${deviation.value.currency}); normalize to one currency at one valuation instant first`)
    }
    estimateTotal += deviation.value.estimateMinor
    actualTotal += deviation.value.actualMinor
    sampleCount++
    basisKeys.push(deviation.value.projectionKey)
  }

  const frozen = (modifierPpm: number, explanation: string): CalibrationAdvice => Object.freeze({
    schema: OUTCOME_CALIBRATION_SCHEMA,
    appliesTo: 'ranking_and_future_estimate_display' as const,
    modifierPpm,
    sampleCount,
    indeterminateCount,
    explanation,
    basisProjectionKeys: Object.freeze([...basisKeys]) as readonly string[],
    admissibleForHardBudget: false as const,
  })

  if (sampleCount < CALIBRATION_MIN_SAMPLE) {
    return pass(frozen(
      CALIBRATION_MODIFIER_PPM_NEUTRAL,
      `neutral ×1.0: ${sampleCount} comparable sample(s) < CALIBRATION_MIN_SAMPLE ${CALIBRATION_MIN_SAMPLE} (${indeterminateCount} indeterminate counted, never valued) — a thin sample is not evidence`,
    ))
  }
  if (estimateTotal <= 0n) {
    return pass(frozen(
      CALIBRATION_MODIFIER_PPM_NEUTRAL,
      `neutral ×1.0: aggregate estimate basis is ${estimateTotal.toString()} minor units, so no ratio is defined (${indeterminateCount} indeterminate counted)`,
    ))
  }
  const rawPpm = Number((actualTotal * 1_000_000n) / estimateTotal)
  const clamped = Math.min(CALIBRATION_MODIFIER_PPM_MAX, Math.max(CALIBRATION_MODIFIER_PPM_MIN, rawPpm))
  const clampNote = clamped === rawPpm ? '' : ` (raw ${rawPpm} clamped into [${CALIBRATION_MODIFIER_PPM_MIN},${CALIBRATION_MODIFIER_PPM_MAX}])`
  return pass(frozen(
    clamped,
    `actual/estimate = ${actualTotal.toString()}/${estimateTotal.toString()} ${currency ?? ''} over ${sampleCount} confirmed sample(s)${clampNote}; ${indeterminateCount} indeterminate counted separately; applies to ranking and future estimate display only`,
  ))
}

/** Bounded ranking application: a finite score in, a finite score out. */
export function applyCalibrationToRankingScore(score: number, advice: CalibrationAdvice): OutcomeResult<number> {
  if (!Number.isFinite(score)) return fail('closed_set', `ranking score must be finite, got ${String(score)}`)
  if (!Number.isInteger(advice?.modifierPpm) || advice.modifierPpm < CALIBRATION_MODIFIER_PPM_MIN || advice.modifierPpm > CALIBRATION_MODIFIER_PPM_MAX) {
    return fail('bound_exceeded', `calibration modifier ${String(advice?.modifierPpm)} is outside the declared bounds [${CALIBRATION_MODIFIER_PPM_MIN},${CALIBRATION_MODIFIER_PPM_MAX}]`)
  }
  if (advice.appliesTo !== 'ranking_and_future_estimate_display') {
    return fail('closed_set', `calibration appliesTo must be 'ranking_and_future_estimate_display', got ${JSON.stringify(advice.appliesTo)}`)
  }
  return pass((score * advice.modifierPpm) / 1_000_000)
}

/** A calibrated display amount: explicitly NOT budget-admissible. */
export interface CalibratedDisplayEstimate {
  readonly amountMinor: bigint
  readonly currency: string
  readonly appliesTo: 'ranking_and_future_estimate_display'
  readonly admissibleForHardBudget: false
  readonly explanation: string
}

export function calibratedDisplayEstimate(estimate: MoneyAmount, advice: CalibrationAdvice): OutcomeResult<CalibratedDisplayEstimate> {
  if (typeof estimate?.amountMinor !== 'bigint') return fail('closed_set', 'estimate must be an fx-contract MoneyAmount')
  const applied = applyCalibrationToRankingScore(1, advice)
  if (!applied.ok) return applied
  const scaled = (estimate.amountMinor * BigInt(advice.modifierPpm)) / 1_000_000n
  return pass(Object.freeze({
    amountMinor: scaled,
    currency: estimate.currency as string,
    appliesTo: 'ranking_and_future_estimate_display' as const,
    admissibleForHardBudget: false as const,
    explanation: `${advice.explanation} — display/ranking only; the hard budget verdict reads the authoritative amount`,
  }))
}

/** Sources that may become a budget-admissible total. Calibration is not one. */
export const AUTHORITATIVE_TOTAL_SOURCES = ['immutable_quote', 'supplier_final'] as const
export type AuthoritativeTotalSource = (typeof AUTHORITATIVE_TOTAL_SOURCES)[number]

/** Branded budget-admissible total: constructible only from an authoritative source. */
export interface AuthoritativeTotal {
  readonly authoritativeSource: AuthoritativeTotalSource
  readonly amount: NormalizedAmount
}

export function authoritativeTotal(amount: NormalizedAmount, source: unknown): OutcomeResult<AuthoritativeTotal> {
  if (!(AUTHORITATIVE_TOTAL_SOURCES as readonly string[]).includes(source as string)) {
    return fail('hard_budget_guard', `a budget-admissible total must come from [${AUTHORITATIVE_TOTAL_SOURCES.join('/')}], got ${JSON.stringify(source)} — a calibrated or modeled amount is never budget-admissible`)
  }
  if (typeof amount?.amountMinor !== 'bigint' || typeof amount?.valuationAsOf !== 'string') {
    return fail('closed_set', 'authoritative total must be an fx-contract NormalizedAmount (currency + bigint minor + valuation instant)')
  }
  return pass(Object.freeze({ authoritativeSource: source as AuthoritativeTotalSource, amount }))
}

/**
 * The user's hard budget verdict. Structurally unreachable from calibration:
 * it admits only an `AuthoritativeTotal`, and a cast-in object that carries no
 * admitted `authoritativeSource` — or that advertises
 * `admissibleForHardBudget: false` — is refused with `hard_budget_guard`.
 * Currency / valuation-instant agreement is delegated to fx-contract.
 */
export function hardBudgetVerdict(total: AuthoritativeTotal, budget: NormalizedAmount): OutcomeResult<{ withinBudget: boolean; valuationAsOf: string }> {
  const candidate = total as unknown as Record<string, unknown>
  if (candidate?.['admissibleForHardBudget'] === false) {
    return fail('hard_budget_guard', 'a calibrated/display amount advertises admissibleForHardBudget=false and can never override the user hard budget (#340 acceptance 4)')
  }
  if (!(AUTHORITATIVE_TOTAL_SOURCES as readonly string[]).includes(total?.authoritativeSource)) {
    return fail('hard_budget_guard', `hard budget verdict admits only an AuthoritativeTotal from [${AUTHORITATIVE_TOTAL_SOURCES.join('/')}], got ${JSON.stringify(candidate?.['authoritativeSource'])}`)
  }
  try {
    const cmp = compareMoney(total.amount, budget)
    return pass({ withinBudget: cmp <= 0, valuationAsOf: total.amount.valuationAsOf })
  } catch (e) {
    return fail('mixed_valuation_basis', `hard budget comparison requires one currency at one valuation instant: ${e instanceof Error ? e.message : String(e)}`)
  }
}

// ---------------------------------------------------------------------------
// 7. Real-order ingestion seam (interface + data shape only; zero sources read)
// ---------------------------------------------------------------------------

/** A future authorized supplier-outcome source. No implementation is admitted. */
export interface SupplierOutcomeSource {
  readonly id: string
  /** why this source may legally be read (authorization record reference) */
  readonly authorization_basis: string
  fetchOutcome(query: { attemptId: string; customerReferenceNo: string }): Promise<
    | { ok: true; observation: OutcomeObservation }
    | { ok: false; code: 'miss' | 'stale' | 'error' | 'permission_denied'; detail: string }
  >
}

/** Runtime source registry, frozen empty. A non-empty value is a founder decision. */
export const LIVE_SUPPLIER_OUTCOME_SOURCES: readonly SupplierOutcomeSource[] = []

/**
 * The only entry point to a real supplier outcome. While `OUTCOME_TRIGGER_FIRED`
 * is false this refuses BEFORE reading any source, so zero supplier records are
 * consulted (the fetch-spy zero-call proof in run-all §85).
 */
export async function ingestSupplierOutcome(
  query: { attemptId: string; customerReferenceNo: string },
  options?: { sources?: readonly SupplierOutcomeSource[]; triggerFired?: boolean },
): Promise<OutcomeResult<OutcomeObservation>> {
  const triggerFired = options?.triggerFired ?? OUTCOME_TRIGGER_FIRED
  if (!triggerFired) {
    return fail(
      'trigger_deferred',
      '#340 trigger has not fired (supplier protocol + WriteGate production admission + authorized real order/refund authority facts); zero supplier outcome sources consulted — fixtures, model self-reports and booking attempts do not count as a sale',
    )
  }
  const sources = options?.sources ?? LIVE_SUPPLIER_OUTCOME_SOURCES
  if (sources.length === 0) {
    return fail('binding_incomplete', 'no supplier outcome source admitted in the registry; admitting one requires an authorization_basis and is a founder decision')
  }
  let last: OutcomeResult<OutcomeObservation> | null = null
  for (const source of sources) {
    const out = await source.fetchOutcome(query)
    if (out.ok) return pass(out.observation)
    last = fail(out.code === 'permission_denied' ? 'binding_incomplete' : 'not_comparable', `${source.id}: ${out.code} — ${out.detail} (a probe failure is not proof that no order exists)`)
  }
  return last ?? fail('not_comparable', 'no supplier outcome source produced an observation')
}
