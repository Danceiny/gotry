/**
 * Outcome ↔ planning-estimate projection contract tests (issue #340 contract slice,
 * SIMULATED-TRIGGER DRILL — fully offline, zero network, zero subprocess, zero CLI).
 *
 * ⚠ Evidence label: `simulated_trigger_drill` / `fixture_contract`. The external
 * trigger of #340 is SIMULATED here by replaying the hotelbyte fake-CLI outcome
 * vocabulary as fixtures (read-only reuse of ts/scripts/hotelbyte-spawn-e2e-tests.ts
 * and ts/capabilities/hotelbyte-transaction.ts). That is NOT the real trigger: no
 * real order, refund authority record or WriteGate admission exists, so nothing
 * below counts as real-order evidence and #340 stays open and default-off.
 *
 * Sections:
 *  A. Association key (plan estimate ↔ immutable quote ↔ attempt ↔ ledger intent):
 *     four mandatory keys, deterministic derivation, each omission fail-closed.
 *  B. Status closed set + settlement semantics: `unknown` is never success and
 *     never comparable; the LOCAL ledger word `compensated` is never an outcome.
 *  C. Transition table: open→open / open→terminal admitted; terminal→open refused
 *     (regression); terminal→unreachable terminal refused (conflict); same→same
 *     idempotent; the frozen progression DAG pinned member by member.
 *  D. Append-only ingest: fixture vocabulary mapping, idempotent replay, key
 *     reuse with a different payload refused, LATE terminal accepted and flagged,
 *     clock sanity, negative list (sensitive fields + credential value shapes),
 *     refunded without authority refused, cancel serviceFee as refund refused.
 *  E. Revocation + deterministic fold: nothing mutated or deleted, re-fold == read.
 *  F. Deviation: confirmed only; unknown/pending → `not_comparable` and explicitly
 *     NOT zero; mixed valuation instant / currency refused; cross-currency works
 *     only through real FX evidence pinned to ONE instant.
 *  G. Calibration: indeterminate counted but never valued, thin sample → neutral,
 *     bounds clamped, ranking reorder allowed; hard-budget falsification — a
 *     calibrated amount can never flip the user's budget verdict.
 *  H. Ingestion seam: trigger frozen false, registry frozen empty, fetch-spy
 *     zero-call proof (zero supplier records consulted before the trigger).
 *
 * Run (from ts/): npx tsx scripts/outcome-projection-tests.ts
 */

import {
  OUTCOME_CALIBRATION_SCHEMA,
  OUTCOME_EVIDENCE_ALLOWED_KEYS,
  OUTCOME_PROJECTION_SCHEMA,
  OUTCOME_STATUSES,
  OUTCOME_TRIGGER_FIRED,
  OPEN_OUTCOME_STATUSES,
  TERMINAL_OUTCOME_STATUSES,
  TERMINAL_PROGRESSIONS,
  CALIBRATION_MIN_SAMPLE,
  CALIBRATION_MODIFIER_PPM_MAX,
  CALIBRATION_MODIFIER_PPM_MIN,
  CALIBRATION_MODIFIER_PPM_NEUTRAL,
  LIVE_SUPPLIER_OUTCOME_SOURCES,
  MAX_REASON_CHARS,
  appendOutcome,
  applyCalibrationToRankingScore,
  associationKey,
  authoritativeTotal,
  calibratedDisplayEstimate,
  calibrationFromDeviations,
  comparableForDeviation,
  countsAsSettledSuccess,
  deviationOf,
  emptyProjection,
  foldProjection,
  hardBudgetVerdict,
  ingestSupplierOutcome,
  isOutcomeStatus,
  outcomeEvidenceViolation,
  revokeEntry,
  statusTerminality,
  transitionAllowed,
  type CalibrationInput,
  type DeviationBasis,
  type OutcomeErrorCode,
  type OutcomeProjection,
  type OutcomeResult,
  type OutcomeStatus,
  type SupplierOutcomeSource,
} from '../src/outcome-projection.ts'
import {
  REFUND_AUTHORITY_SOURCES,
  SERVICE_FEE_SOURCE,
} from '../src/booking-surface/cancel-refund-commission.ts'
import {
  buildFxFact,
  convertMoney,
  parseCurrency,
  parseMoney,
  pinNativeMoney,
  type FxProviderDescriptor,
} from '../capabilities/fx-contract.ts'

let passed = 0
function check(cond: boolean, msg: string): void {
  if (cond) {
    passed++
    console.log(`  ok - ${msg}`)
  } else {
    console.error(`  FAIL - ${msg}`)
    process.exitCode = 1
  }
}

/** Negative assertion: must be a typed refusal with the expected code and evidence. */
function expectRefusal<T>(result: OutcomeResult<T>, code: OutcomeErrorCode, needle: string, msg: string): void {
  if (result.ok) {
    check(false, `${msg} (expected refusal ${code}, got ok)`)
    return
  }
  check(
    result.code === code && result.detail.includes(needle),
    `${msg} (refused ${result.code}${result.code === code ? '' : ` ≠ ${code}`}, evidence contains "${needle}": ${result.detail.includes(needle)})`,
  )
}

const T_QUOTE = '2026-10-04T09:00:00.000Z'
const T_BOOK = '2026-10-04T09:05:00.000Z'
const T_PROBE_1 = '2026-10-04T09:08:00.000Z'
const T_PROBE_2 = '2026-10-04T09:20:00.000Z'
const T_LATE = '2026-10-04T09:06:00.000Z' // predates T_PROBE_1: a LATE supplier observation
const T_NOW = '2026-10-04T10:00:00.000Z'

function freshProjection(): OutcomeProjection {
  const key = associationKey({
    planEstimateId: 'plan-est-7a1',
    quoteId: 'quote-immutable-33c',
    attemptId: 'attempt-9f2',
    intentIdemKey: 'intent-idem-0001',
  })
  if (!key.ok) throw new Error(`fixture association key failed: ${key.detail}`)
  return emptyProjection(key.value)
}

// ---------------------------------------------------------------------------
// A. Association key
// ---------------------------------------------------------------------------
console.log('A. association key: plan estimate ↔ immutable quote ↔ attempt ↔ ledger intent')
const keyA = associationKey({ planEstimateId: 'p1', quoteId: 'q1', attemptId: 'a1', intentIdemKey: 'i1' })
check(keyA.ok && keyA.value.projectionKey.length > 0, 'four complete keys admitted and a projection key derived')
const keyAagain = associationKey({ planEstimateId: ' p1 ', quoteId: 'q1', attemptId: 'a1', intentIdemKey: 'i1' })
check(keyA.ok && keyAagain.ok && keyA.value.projectionKey === keyAagain.value.projectionKey, 'derivation is deterministic and whitespace-normalized')
const keyOtherQuote = associationKey({ planEstimateId: 'p1', quoteId: 'q2', attemptId: 'a1', intentIdemKey: 'i1' })
check(keyA.ok && keyOtherQuote.ok && keyA.value.projectionKey !== keyOtherQuote.value.projectionKey, 'a different immutable quote yields a different association (quotes are not interchangeable)')
expectRefusal(associationKey({ planEstimateId: '', quoteId: 'q1', attemptId: 'a1', intentIdemKey: 'i1' }), 'binding_incomplete', 'planEstimateId', 'missing planEstimateId refused')
expectRefusal(associationKey({ planEstimateId: 'p1', quoteId: undefined, attemptId: 'a1', intentIdemKey: 'i1' }), 'binding_incomplete', 'quoteId', 'missing quoteId refused')
expectRefusal(associationKey({ planEstimateId: 'p1', quoteId: 'q1', attemptId: '   ', intentIdemKey: 'i1' }), 'binding_incomplete', 'attemptId', 'blank attemptId refused')
expectRefusal(associationKey({ planEstimateId: 'p1', quoteId: 'q1', attemptId: 'a1', intentIdemKey: 42 }), 'binding_incomplete', 'intentIdemKey', 'non-string intentIdemKey refused')
expectRefusal(associationKey({ planEstimateId: 'p1', quoteId: 'q1', attemptId: 'a1', intentIdemKey: '' }), 'binding_incomplete', 'no default, no derivation from a sibling key', 'refusal states that no key is defaulted or derived')

// ---------------------------------------------------------------------------
// B. Status closed set + settlement semantics
// ---------------------------------------------------------------------------
console.log('B. status closed set: unknown is never a sale, `compensated` is never an outcome')
check(OUTCOME_STATUSES.length === 6 && OUTCOME_STATUSES.join('/') === 'pending/confirmed/failed/cancelled/refunded/unknown', 'alphabet frozen: pending/confirmed/failed/cancelled/refunded/unknown')
check(OPEN_OUTCOME_STATUSES.length + TERMINAL_OUTCOME_STATUSES.length === OUTCOME_STATUSES.length, 'open ∪ terminal partitions the alphabet exactly')
check(!isOutcomeStatus('compensated') && !isOutcomeStatus('reconciled_success') && !isOutcomeStatus('success'), 'local-ledger / reconciliation / raw-CLI words are not outcome statuses')
check(countsAsSettledSuccess('confirmed'), 'confirmed is the only settled success')
check(!countsAsSettledSuccess('unknown') && !countsAsSettledSuccess('pending'), 'unknown and pending are never settled success')
check(!countsAsSettledSuccess('refunded') && !countsAsSettledSuccess('cancelled') && !countsAsSettledSuccess('failed'), 'no other terminal is a settled success')
check(comparableForDeviation('confirmed') && !comparableForDeviation('unknown') && !comparableForDeviation('pending'), 'only confirmed is deviation-comparable')
check(statusTerminality('unknown') === 'open' && statusTerminality('pending') === 'open' && statusTerminality('refunded') === 'terminal', 'terminality classification')

// ---------------------------------------------------------------------------
// C. Transition table
// ---------------------------------------------------------------------------
console.log('C. transitions: terminal states never regress')
check(transitionAllowed('unknown', 'pending').ok, 'open → open admitted (a probe may refine without settling)')
check(transitionAllowed('pending', 'unknown').ok, 'open → open admitted in both directions (a probe failure returns to unknown)')
for (const terminal of TERMINAL_OUTCOME_STATUSES) {
  check(transitionAllowed('unknown', terminal).ok, `open unknown → terminal ${terminal} admitted (late settlement)`)
  for (const open of OPEN_OUTCOME_STATUSES) {
    expectRefusal(transitionAllowed(terminal, open), 'terminal_regression', 'must not regress', `terminal ${terminal} → open ${open} refused`)
  }
  const r = transitionAllowed(terminal, terminal)
  check(r.ok && r.value === 'idempotent', `terminal ${terminal} re-observed is idempotent, not a conflict`)
}
check(TERMINAL_PROGRESSIONS.confirmed.join('/') === 'cancelled/refunded' && TERMINAL_PROGRESSIONS.cancelled.join('/') === 'refunded', 'frozen progression DAG: confirmed→{cancelled,refunded}, cancelled→{refunded}')
check(TERMINAL_PROGRESSIONS.failed.length === 0 && TERMINAL_PROGRESSIONS.refunded.length === 0, 'failed and refunded are absorbing')
check(transitionAllowed('confirmed', 'cancelled').ok && transitionAllowed('cancelled', 'refunded').ok, 'admitted terminal progressions')
expectRefusal(transitionAllowed('failed', 'confirmed'), 'terminal_conflict', 'does not reach terminal confirmed', 'failed → confirmed refused (no silent flip)')
expectRefusal(transitionAllowed('cancelled', 'confirmed'), 'terminal_conflict', 'does not reach terminal confirmed', 'cancelled → confirmed refused')
expectRefusal(transitionAllowed('refunded', 'cancelled'), 'terminal_conflict', 'reachable: [none]', 'refunded → cancelled refused (absorbing terminal)')
expectRefusal(transitionAllowed('confirmed', 'failed'), 'terminal_conflict', 'does not reach terminal failed', 'confirmed → failed refused')
expectRefusal(transitionAllowed('confirmed', 'bogus' as OutcomeStatus), 'closed_set', 'must be in', 'a word outside the alphabet refused')

// ---------------------------------------------------------------------------
// D. Append-only ingest, driven by the hotelbyte fake-CLI fixture vocabulary
// ---------------------------------------------------------------------------
console.log('D. append-only ingest (fixture vocabulary from the hotelbyte fake CLI)')

/**
 * Fixture adapter (test-only; the product has no such adapter): the fake-CLI /
 * query-orders words observed in ts/scripts/hotelbyte-spawn-e2e-tests.ts and the
 * SUPPLIER_TERMINAL_NEGATIVE set of ts/capabilities/hotelbyte-transaction.ts,
 * mapped to the #340 alphabet. Every indeterminate word maps to `unknown`.
 */
const FIXTURE_CLI_VOCABULARY: Readonly<Record<string, OutcomeStatus>> = {
  // book stdout words
  success_with_binding: 'confirmed',
  pending: 'pending',
  failed: 'failed',
  success_without_binding: 'unknown', // exit0 success but no customerReferenceNo
  reference_mismatch: 'unknown',
  exit0_garbage: 'unknown',
  nonzero_exit: 'unknown',
  timeout: 'unknown',
  process_killed: 'unknown',
  // query-orders supplierStatus words
  confirmed: 'confirmed',
  completed: 'confirmed',
  processing: 'pending',
  cancelled: 'cancelled',
  auto_canceled: 'cancelled',
  expired: 'cancelled',
  query_miss: 'unknown',
  query_failed: 'unknown',
  query_malformed: 'unknown',
  permission_denied: 'unknown',
}
const INDETERMINATE_FIXTURE_WORDS = [
  'success_without_binding', 'reference_mismatch', 'exit0_garbage', 'nonzero_exit',
  'timeout', 'process_killed', 'query_miss', 'query_failed', 'query_malformed', 'permission_denied',
]
check(
  INDETERMINATE_FIXTURE_WORDS.every(w => FIXTURE_CLI_VOCABULARY[w] === 'unknown'),
  `all ${INDETERMINATE_FIXTURE_WORDS.length} indeterminate fixture words map to unknown (exit0 is not a success proof)`,
)
check(
  Object.values(FIXTURE_CLI_VOCABULARY).every(isOutcomeStatus),
  'the fixture vocabulary maps only into the frozen alphabet',
)

const EVIDENCE_OK = { supplier_status_word: 'success', supplier_order_ref_digest: 'sha16:aa11bb22', probe_digest: 'sha256:deadbeef' }

const p0 = freshProjection()
// The host probe at T_PROBE_1 timed out → unknown. The supplier's own confirmation
// instant (T_LATE) predates that probe and will arrive afterwards: the LATE terminal.
const step1 = appendOutcome(p0, { idemKey: 'obs-1', status: 'unknown', observedAt: T_PROBE_1, evidence: { classification: 'timeout' } }, T_NOW)
check(step1.ok && step1.value.appended && step1.value.projection.entries.length === 1, 'first observation (timeout → unknown) appended')
check(p0.entries.length === 0, 'the input projection is not mutated (pure, append-only returns a new value)')

const afterUnknown = step1.ok ? step1.value.projection : p0
const replay = appendOutcome(afterUnknown, { idemKey: 'obs-1', status: 'unknown', observedAt: T_PROBE_1, evidence: { classification: 'timeout' } }, T_NOW)
check(replay.ok && replay.value.appended === false && replay.value.transition === 'idempotent' && replay.value.projection.entries.length === 1, 'replay of the same idempotency key with the same payload is a no-op (zero new entries)')
expectRefusal(
  appendOutcome(afterUnknown, { idemKey: 'obs-1', status: 'confirmed', observedAt: T_BOOK, evidence: EVIDENCE_OK }, T_NOW),
  'idempotency_conflict', 'is a conflict, never an overwrite',
  'the same idempotency key with a different payload is a conflict',
)

const lateTerminal = appendOutcome(
  afterUnknown,
  { idemKey: 'obs-2', status: 'confirmed', observedAt: T_LATE, amount: { money: parseMoney('CNY', '880.00'), source: 'supplier_final_charge' }, evidence: EVIDENCE_OK },
  T_NOW,
)
check(lateTerminal.ok && lateTerminal.value.appended && lateTerminal.value.lateObservation === true, 'a LATE terminal observation (observed_at predating the last probe) is accepted and flagged')
const confirmedProjection = lateTerminal.ok ? lateTerminal.value.projection : afterUnknown
check(foldProjection(confirmedProjection).status === 'confirmed' && foldProjection(confirmedProjection).settledSuccess, 'fold settles on the late terminal')

expectRefusal(
  appendOutcome(confirmedProjection, { idemKey: 'obs-3', status: 'unknown', observedAt: T_PROBE_2, evidence: { classification: 'query_failed' } }, T_NOW),
  'terminal_regression', 'a later probe failure is not evidence',
  'after a terminal, a later unknown probe cannot regress the projection',
)
expectRefusal(
  appendOutcome(confirmedProjection, { idemKey: 'obs-4', status: 'failed', observedAt: T_PROBE_2, evidence: EVIDENCE_OK }, T_NOW),
  'terminal_conflict', 'does not reach terminal failed',
  'after confirmed, a contradicting failed is an explicit conflict',
)

expectRefusal(
  appendOutcome(freshProjection(), { idemKey: 'o', status: 'compensated', observedAt: T_BOOK }, T_NOW),
  'local_ledger_status_not_supplier_outcome', 'never means refunded',
  'the LOCAL ledger word `compensated` is refused as a supplier outcome (compensated ≠ refunded)',
)
expectRefusal(
  appendOutcome(freshProjection(), { idemKey: 'o', status: 'success', observedAt: T_BOOK }, T_NOW),
  'closed_set', 'must be one of',
  'the raw CLI word `success` is not an outcome status (adapters must map explicitly)',
)
expectRefusal(
  appendOutcome(freshProjection(), { idemKey: '', status: 'unknown', observedAt: T_BOOK }, T_NOW),
  'binding_incomplete', 'idemKey',
  'an observation without an idempotency key is refused',
)
expectRefusal(
  appendOutcome(freshProjection(), { idemKey: 'o', status: 'unknown', observedAt: '2026-10-04' }, T_NOW),
  'bad_ts', 'date-only',
  'a date-only observed_at is refused (observations must be orderable)',
)
expectRefusal(
  appendOutcome(freshProjection(), { idemKey: 'o', status: 'unknown', observedAt: '2026-10-04T11:00:00.000Z' }, T_NOW),
  'bad_ts', 'postdates the injected clock',
  'an observation postdating the injected clock is refused (impossible provenance)',
)
expectRefusal(
  appendOutcome(freshProjection(), { idemKey: 'o', status: 'unknown', observedAt: T_BOOK, reason: 'x'.repeat(MAX_REASON_CHARS + 1) }, T_NOW),
  'bound_exceeded', 'a label, never a transcript',
  'an over-long reason is refused (bounded text)',
)

console.log('D2. negative list: sensitive order fields and credentials never enter the projection')
check(outcomeEvidenceViolation(EVIDENCE_OK) === null, 'an allow-listed digest/pointer record passes')
check(OUTCOME_EVIDENCE_ALLOWED_KEYS.length === 10, 'the evidence key allow-list is a closed set of 10 digest/pointer fields')
for (const [field, label] of [['guest_name', 'guest name'], ['passport', 'passport'], ['card_number', 'card number'], ['authorization', 'authorization header'], ['raw_response', 'raw supplier response'], ['stdout', 'CLI stdout']] as const) {
  expectRefusal(
    appendOutcome(freshProjection(), { idemKey: 'o', status: 'unknown', observedAt: T_BOOK, evidence: { [field]: 'whatever' } }, T_NOW),
    'negative_list', `sensitive order field '${field}'`,
    `${label} field refused by name`,
  )
}
expectRefusal(
  appendOutcome(freshProjection(), { idemKey: 'o', status: 'unknown', observedAt: T_BOOK, evidence: { hotel_name: 'Some Hotel' } }, T_NOW),
  'negative_list', 'is not in the evidence allow-list',
  'an unlisted key is refused even when it looks harmless (allow-list, not deny-list)',
)
for (const [value, label] of [
  ['bearer abcdefgh12345678', 'bearer token value'],
  ['sk-abcdefghijklmnop', 'secret-key value'],
  ['api_key=zzzzzz', 'credential assignment value'],
  ['13800138000', 'mobile number value'],
  ['123456789012345678', 'document/card number value'],
  ['guest@example.com', 'email value'],
  ['https://supplier.example/order/1', 'URL value'],
] as const) {
  expectRefusal(
    appendOutcome(freshProjection(), { idemKey: 'o', status: 'unknown', observedAt: T_BOOK, evidence: { probe_digest: value } }, T_NOW),
    'negative_list', 'in an evidence value',
    `${label} refused by value scan even under an allow-listed key`,
  )
}
check(outcomeEvidenceViolation('not-an-object') !== null && outcomeEvidenceViolation([1, 2]) !== null, 'a non-object evidence payload is refused')

// A hex digest legitimately contains long runs of decimal digits a few percent of
// the time. The numeric-id patterns are anchored to a non-alphanumeric boundary so
// such a digest is NOT mistaken for a document number (unanchored, these would all
// be refused and the negative list would reject legitimate evidence).
for (const digest of [
  'a12345678901234567b',                                               // 17-digit run inside hex
  'sha256:bb123456789012345678901234567890cc',                         // long run after a prefix
  '0123456789012345abcdef0123456789abcdef0123456789abcdef0123456789',  // 64-char digest, leading run
  'ab1380013800012345ef',                                              // embeds a mobile-shaped run
  'sha16:00000000000000000a',                                          // digit run + one hex letter
  'HB123456789012345678ORD',                                           // non-hex ref: isolates the anchors
]) {
  check(
    outcomeEvidenceViolation({ probe_digest: digest, supplier_order_ref_digest: digest }) === null,
    `a hex digest with a 15+ digit run is accepted, not flagged as a document number: ${digest.slice(0, 28)}`,
  )
  const appended = appendOutcome(freshProjection(), { idemKey: 'o', status: 'unknown', observedAt: T_BOOK, evidence: { probe_digest: digest } }, T_NOW)
  check(appended.ok, `the same digest is accepted by appendOutcome: ${digest.slice(0, 28)}`)
}
// Standalone identifier-shaped runs stay refused at any length, including the
// pure-decimal case that is deliberately NOT given the hex-digest exemption.
for (const [value, label] of [
  ['12345678901234567', '17-digit standalone run (pure decimal: no hex exemption)'],
  ['123456789012345678', '18-digit ID-card-length run'],
  ['12345678901234567X', 'ID-card run with an X check digit'],
  ['1234567890123456789', '19-digit card-length run'],
  ['sha256:12345678901234567', 'pure-decimal run behind a digest prefix'],
  ['ref 13800138000 ok', 'standalone mobile number inside prose'],
] as const) {
  check(
    outcomeEvidenceViolation({ probe_digest: value }) !== null,
    `a standalone identifier-shaped value is still refused: ${label}`,
  )
}
check(outcomeEvidenceViolation({ probe_digest: 12345678901234567 as unknown as string }) !== null, 'a numeric (non-string) leaf carrying an identifier-shaped run is refused too')
check(outcomeEvidenceViolation({ probe_digest: ['ok', '123456789012345678'] }) !== null, 'the scan reaches identifier-shaped runs nested in an array leaf')

console.log('D3. refund money discipline (serviceFee ≠ refund; refunded needs authority)')
const confirmedThenCancelled = (() => {
  const a = appendOutcome(freshProjection(), { idemKey: 'c1', status: 'confirmed', observedAt: T_BOOK, amount: { money: parseMoney('CNY', '880.00'), source: 'supplier_final_charge' }, evidence: EVIDENCE_OK }, T_NOW)
  if (!a.ok) throw new Error(a.detail)
  const b = appendOutcome(a.value.projection, { idemKey: 'c2', status: 'cancelled', observedAt: T_PROBE_1, evidence: { supplier_status_word: 'cancelled' } }, T_NOW)
  if (!b.ok) throw new Error(b.detail)
  return b.value.projection
})()
expectRefusal(
  appendOutcome(confirmedThenCancelled, { idemKey: 'c3', status: 'refunded', observedAt: T_PROBE_2, evidence: { supplier_status_word: 'refunded' } }, T_NOW),
  'evidence_required', 'refunded only from supplier/wallet refund records',
  'refunded without an amount/authority is refused',
)
expectRefusal(
  appendOutcome(confirmedThenCancelled, { idemKey: 'c3', status: 'refunded', observedAt: T_PROBE_2, amount: { money: parseMoney('CNY', '50.00'), source: SERVICE_FEE_SOURCE }, evidence: { amount_source: SERVICE_FEE_SOURCE } }, T_NOW),
  'service_fee_as_refund', 'never the customer refund amount',
  'the cancel service fee offered as the refund amount is refused',
)
expectRefusal(
  appendOutcome(confirmedThenCancelled, { idemKey: 'c3', status: 'refunded', observedAt: T_PROBE_2, amount: { money: parseMoney('CNY', '830.00'), source: 'model_guess' }, evidence: {} }, T_NOW),
  'evidence_required', REFUND_AUTHORITY_SOURCES[0],
  'a refund amount from a non-authority source is refused',
)
const refundOk = appendOutcome(
  confirmedThenCancelled,
  { idemKey: 'c3', status: 'refunded', observedAt: T_PROBE_2, amount: { money: parseMoney('CNY', '830.00'), source: 'supplier_refund_record' }, evidence: { refund_evidence_kind: 'supplier_refund_record', refund_evidence_digest: 'sha256:cafe' } },
  T_NOW,
)
check(refundOk.ok && foldProjection(refundOk.value.projection).status === 'refunded', 'refunded with an authoritative refund record is admitted (confirmed→cancelled→refunded)')
check(refundOk.ok && !foldProjection(refundOk.value.projection).settledSuccess, 'a refunded projection is terminal but is not a settled success')
expectRefusal(
  appendOutcome(freshProjection(), { idemKey: 'f1', status: 'confirmed', observedAt: T_BOOK, amount: { money: { currency: parseCurrency('CNY'), amountMinor: 880.0 as unknown as bigint }, source: 's' }, evidence: {} }, T_NOW),
  'closed_set', 'floats are refused',
  'a float amount is refused (fx-contract MoneyAmount only)',
)

// ---------------------------------------------------------------------------
// E. Revocation + deterministic fold
// ---------------------------------------------------------------------------
console.log('E. revocable projection: append-only, nothing deleted, re-fold == direct read')
const mistaken = (() => {
  const a = appendOutcome(freshProjection(), { idemKey: 'm1', status: 'unknown', observedAt: T_BOOK, evidence: { classification: 'timeout' } }, T_NOW)
  if (!a.ok) throw new Error(a.detail)
  const b = appendOutcome(a.value.projection, { idemKey: 'm2', status: 'confirmed', observedAt: T_PROBE_1, amount: { money: parseMoney('CNY', '880.00'), source: 'supplier_final_charge' }, evidence: EVIDENCE_OK }, T_NOW)
  if (!b.ok) throw new Error(b.detail)
  return { projection: b.value.projection, confirmedEntryId: b.value.entry!.entry_id }
})()
check(foldProjection(mistaken.projection).status === 'confirmed', 'before revocation the fold reads confirmed')
const revoked = revokeEntry(mistaken.projection, { targetEntryId: mistaken.confirmedEntryId, reason: 'ingested against the wrong attempt during the drill', actor: 'operator:drill', idemKey: 'rev-1' }, T_NOW)
check(revoked.ok && revoked.value.projection.entries.length === 3, 'a revocation is itself an appended entry (3 entries, nothing deleted)')
const revokedProjection = revoked.ok ? revoked.value.projection : mistaken.projection
check(revokedProjection.entries.some(e => e.entry_id === mistaken.confirmedEntryId), 'the revoked observation is still physically present (append-only)')
const revokedView = foldProjection(revokedProjection)
check(revokedView.status === 'unknown' && revokedView.revokedEntryIds.length === 1 && !revokedView.settledSuccess, 'the fold skips the revoked observation and falls back to the prior effective status')
check(JSON.stringify(foldProjection(revokedProjection)) === JSON.stringify(revokedView), 're-folding the same projection is deterministic (replay == direct read)')
check(revokedView.foldConflicts.length === 0, 'a well-formed projection folds with zero conflicts')
expectRefusal(revokeEntry(revokedProjection, { targetEntryId: mistaken.confirmedEntryId, reason: 'again', actor: 'op', idemKey: 'rev-2' }, T_NOW), 'unknown_entry', 'already revoked', 'revoking an already-revoked entry is refused')
expectRefusal(revokeEntry(revokedProjection, { targetEntryId: 'no-such-entry', reason: 'x', actor: 'op', idemKey: 'rev-3' }, T_NOW), 'unknown_entry', 'no observed entry', 'revoking a missing entry is refused')
expectRefusal(revokeEntry(mistaken.projection, { targetEntryId: mistaken.confirmedEntryId, reason: '', actor: 'op', idemKey: 'rev-4' }, T_NOW), 'binding_incomplete', 'not auditable', 'a revocation without a stated reason is refused')
expectRefusal(revokeEntry(mistaken.projection, { targetEntryId: mistaken.confirmedEntryId, reason: 'x', actor: '', idemKey: 'rev-5' }, T_NOW), 'binding_incomplete', 'actor', 'a revocation without an actor is refused')
check(foldProjection(freshProjection()).status === null && foldProjection(freshProjection()).indeterminate, 'an empty projection has status null (never defaulted to a status) and is indeterminate')

// ---------------------------------------------------------------------------
// F. Deviation
// ---------------------------------------------------------------------------
console.log('F. deviation: one valuation instant, never a guessed FX rate, never zero for unknown')
const estimate800 = pinNativeMoney(parseMoney('CNY', '800.00'), T_QUOTE)
const actual880 = pinNativeMoney(parseMoney('CNY', '880.00'), T_QUOTE)
const basisSameInstant: DeviationBasis = { estimate: estimate800, actual: actual880 }
const dev = deviationOf(confirmedProjection, basisSameInstant)
check(dev.ok && dev.value.deltaMinor === 8000n && dev.value.direction === 'over', 'confirmed deviation: ¥880 actual vs ¥800 estimate = +8000 minor units, direction over')
check(dev.ok && dev.value.valuationAsOf === T_QUOTE && dev.value.explanation.includes('valuation instant'), 'the deviation carries the single declared valuation instant and an explanation')
check(dev.ok && dev.value.basisEntryIds.length > 0, 'the deviation names the effective entries it was computed from')

const unknownProjection = (() => {
  const a = appendOutcome(freshProjection(), { idemKey: 'u1', status: 'unknown', observedAt: T_BOOK, evidence: { classification: 'timeout' } }, T_NOW)
  if (!a.ok) throw new Error(a.detail)
  return a.value.projection
})()
const devUnknown = deviationOf(unknownProjection, basisSameInstant)
expectRefusal(devUnknown, 'not_comparable', 'never a zero deviation', 'unknown (timeout) is refused, NOT reported as zero deviation')
check(!devUnknown.ok, 'the unknown refusal returns no numeric value at all (no 0 to accidentally average)')
const pendingProjection = (() => {
  const a = appendOutcome(freshProjection(), { idemKey: 'pd1', status: 'pending', observedAt: T_BOOK, evidence: { supplier_status_word: 'pending' } }, T_NOW)
  if (!a.ok) throw new Error(a.detail)
  return a.value.projection
})()
expectRefusal(deviationOf(pendingProjection, basisSameInstant), 'not_comparable', 'never a zero deviation', 'pending is refused, not zero')
expectRefusal(deviationOf(freshProjection(), basisSameInstant), 'not_comparable', 'absence of an outcome is not a zero deviation', 'an empty projection is refused')
expectRefusal(deviationOf(confirmedThenCancelled, basisSameInstant), 'not_comparable', 'aftercare surface', 'a cancelled outcome has no comparable final charge (aftercare belongs to #233)')

const actualOtherInstant = pinNativeMoney(parseMoney('CNY', '880.00'), T_PROBE_2)
expectRefusal(deviationOf(confirmedProjection, { estimate: estimate800, actual: actualOtherInstant }), 'mixed_valuation_basis', 'valuation instant', 'estimate and actual pinned to different instants are refused (no silent re-pinning)')
const TEST_FX_REGISTRY: readonly FxProviderDescriptor[] = [
  { id: 'fixture-offline-table', tier: 'primary', legal_basis: 'test-only offline fixture (issue #340 drill; no live FX source)' },
]
const usdCnyAtQuote = buildFxFact(
  { base: 'USD', quote: 'CNY', rate: '7.2', provider: 'fixture-offline-table', provenance: '[汇率:fixture@#340 drill]', as_of: T_QUOTE, fetched_at: T_QUOTE },
  TEST_FX_REGISTRY,
)
const actualUsd = convertMoney(parseMoney('USD', '120.00'), 'CNY', usdCnyAtQuote)
const devCross = deviationOf(confirmedProjection, { estimate: estimate800, actual: actualUsd })
check(devCross.ok && devCross.value.actualMinor === 86400n && devCross.value.deltaMinor === 6400n, 'a cross-currency actual is comparable only through real FX evidence pinned to the same instant (USD 120 × 7.2 = ¥864)')
const usdCnyLater = buildFxFact(
  { base: 'USD', quote: 'CNY', rate: '7.3', provider: 'fixture-offline-table', provenance: '[汇率:fixture@#340 drill]', as_of: T_PROBE_2, fetched_at: T_PROBE_2 },
  TEST_FX_REGISTRY,
)
expectRefusal(
  deviationOf(confirmedProjection, { estimate: estimate800, actual: convertMoney(parseMoney('USD', '120.00'), 'CNY', usdCnyLater) }),
  'mixed_valuation_basis', 'valuation instant',
  'an FX fact from another instant cannot be mixed into the comparison (no guessed rate, no re-pinning)',
)

// ---------------------------------------------------------------------------
// G. Calibration + hard budget falsification
// ---------------------------------------------------------------------------
console.log('G. calibration: ranking/future estimates only — never the user hard budget')
function confirmedAt(suffix: string, actualDecimal: string): CalibrationInput {
  const key = associationKey({ planEstimateId: `plan-${suffix}`, quoteId: `quote-${suffix}`, attemptId: `attempt-${suffix}`, intentIdemKey: `intent-${suffix}` })
  if (!key.ok) throw new Error(key.detail)
  const a = appendOutcome(emptyProjection(key.value), { idemKey: `obs-${suffix}`, status: 'confirmed', observedAt: T_BOOK, amount: { money: parseMoney('CNY', actualDecimal), source: 'supplier_final_charge' }, evidence: EVIDENCE_OK }, T_NOW)
  if (!a.ok) throw new Error(a.detail)
  return { projection: a.value.projection, basis: { estimate: estimate800, actual: pinNativeMoney(parseMoney('CNY', actualDecimal), T_QUOTE) } }
}
const thin = calibrationFromDeviations([confirmedAt('s1', '880.00')])
check(thin.ok && thin.value.modifierPpm === CALIBRATION_MODIFIER_PPM_NEUTRAL && thin.value.sampleCount === 1, `a thin sample (1 < ${CALIBRATION_MIN_SAMPLE}) yields the neutral modifier ×1.0`)
check(thin.ok && thin.value.explanation.includes('a thin sample is not evidence'), 'the neutral advice states why it is neutral')
const withIndeterminate = calibrationFromDeviations([
  confirmedAt('s1', '880.00'), confirmedAt('s2', '880.00'), confirmedAt('s3', '880.00'),
  { projection: unknownProjection, basis: basisSameInstant },
  { projection: pendingProjection, basis: basisSameInstant },
  { projection: freshProjection() },
])
check(withIndeterminate.ok && withIndeterminate.value.sampleCount === 3 && withIndeterminate.value.indeterminateCount === 3, 'indeterminate projections are COUNTED (3) but never valued — the sample stays 3')
check(withIndeterminate.ok && withIndeterminate.value.modifierPpm === 1_100_000, 'the modifier reflects only the comparable samples (2640/2400 = ×1.1), unaffected by the indeterminate ones')
check(withIndeterminate.ok && withIndeterminate.value.schema === OUTCOME_CALIBRATION_SCHEMA && withIndeterminate.value.appliesTo === 'ranking_and_future_estimate_display', 'advice is versioned and names its only application surface')
check(withIndeterminate.ok && withIndeterminate.value.admissibleForHardBudget === false, 'advice advertises admissibleForHardBudget = false')
check(withIndeterminate.ok && withIndeterminate.value.basisProjectionKeys.length === 3 && withIndeterminate.value.explanation.includes('indeterminate counted separately'), 'advice is explainable: basis keys + an indeterminate count in the explanation')

const extreme = calibrationFromDeviations([confirmedAt('x1', '400.00'), confirmedAt('x2', '400.00'), confirmedAt('x3', '400.00')])
check(extreme.ok && extreme.value.modifierPpm === CALIBRATION_MODIFIER_PPM_MIN && extreme.value.explanation.includes('clamped'), 'an extreme ratio is clamped to the declared lower bound and the clamp is disclosed')
const extremeHigh = calibrationFromDeviations([confirmedAt('y1', '2400.00'), confirmedAt('y2', '2400.00'), confirmedAt('y3', '2400.00')])
check(extremeHigh.ok && extremeHigh.value.modifierPpm === CALIBRATION_MODIFIER_PPM_MAX, 'an extreme ratio is clamped to the declared upper bound')

const cheapAdvice = extreme.ok ? extreme.value : null
check(cheapAdvice !== null, 'a deflating (×0.8) advice is available for the falsification below')
if (cheapAdvice) {
  const scoreA = applyCalibrationToRankingScore(0.9, cheapAdvice)
  const scoreB = applyCalibrationToRankingScore(0.8, cheapAdvice)
  check(scoreA.ok && scoreB.ok && scoreA.value > scoreB.value, 'the modifier applies to a ranking score monotonically (reordering is its legitimate effect)')
  expectRefusal(applyCalibrationToRankingScore(Number.NaN, cheapAdvice), 'closed_set', 'must be finite', 'a non-finite ranking score is refused')
  expectRefusal(
    applyCalibrationToRankingScore(1, { ...cheapAdvice, modifierPpm: 10 }),
    'bound_exceeded', 'outside the declared bounds',
    'a modifier outside the declared bounds is refused (bounds are structural, not advisory)',
  )

  // --- falsification: calibration must never flip the hard budget verdict ---
  const overBudgetTotal = pinNativeMoney(parseMoney('CNY', '1200.00'), T_QUOTE)
  const budget1000 = pinNativeMoney(parseMoney('CNY', '1000.00'), T_QUOTE)
  const authoritative = authoritativeTotal(overBudgetTotal, 'immutable_quote')
  check(authoritative.ok, 'an immutable-quote total is budget-admissible')
  const rawVerdict = authoritative.ok ? hardBudgetVerdict(authoritative.value, budget1000) : null
  check(rawVerdict !== null && rawVerdict.ok && rawVerdict.value.withinBudget === false, 'the raw authoritative total ¥1200 is over the ¥1000 hard budget')
  const display = calibratedDisplayEstimate(parseMoney('CNY', '1200.00'), cheapAdvice)
  check(display.ok && display.value.amountMinor === 96000n && display.value.admissibleForHardBudget === false, 'the ×0.8 calibrated DISPLAY amount is ¥960 — which would look within budget')
  if (display.ok) {
    const smuggled = { authoritativeSource: 'immutable_quote', amount: { ...overBudgetTotal, amountMinor: display.value.amountMinor }, admissibleForHardBudget: false } as unknown as Parameters<typeof hardBudgetVerdict>[0]
    expectRefusal(hardBudgetVerdict(smuggled, budget1000), 'hard_budget_guard', 'can never override the user hard budget', 'FALSIFICATION: a calibrated amount smuggled into the hard budget verdict is refused')
  }
  const modeled = authoritativeTotal(pinNativeMoney(parseMoney('CNY', '960.00'), T_QUOTE), 'calibrated_estimate')
  expectRefusal(modeled, 'hard_budget_guard', 'never budget-admissible', 'a calibrated/modeled source can never become an AuthoritativeTotal')
  const unlabelled = { amount: overBudgetTotal } as unknown as Parameters<typeof hardBudgetVerdict>[0]
  expectRefusal(hardBudgetVerdict(unlabelled, budget1000), 'hard_budget_guard', 'admits only an AuthoritativeTotal', 'an unlabelled total is refused by the hard budget verdict')
  const mixedBudget = pinNativeMoney(parseMoney('CNY', '1000.00'), T_PROBE_2)
  if (authoritative.ok) {
    expectRefusal(hardBudgetVerdict(authoritative.value, mixedBudget), 'mixed_valuation_basis', 'one valuation instant', 'a budget pinned to another instant is refused')
  }
  // ranking may reorder but the budget-filtered set is unchanged
  const candidates = [
    { id: 'c-over', total: parseMoney('CNY', '1200.00'), semantic: 0.95 },
    { id: 'c-under', total: parseMoney('CNY', '900.00'), semantic: 0.60 },
  ]
  const admitted = candidates.filter(c => {
    const t = authoritativeTotal(pinNativeMoney(c.total, T_QUOTE), 'immutable_quote')
    if (!t.ok) return false
    const v = hardBudgetVerdict(t.value, budget1000)
    return v.ok && v.value.withinBudget
  })
  check(admitted.length === 1 && admitted[0].id === 'c-under', 'the hard budget admits exactly the under-budget candidate, computed from authoritative totals only')
  const reranked = [...candidates].sort((a, b) => {
    const sa = applyCalibrationToRankingScore(a.semantic, cheapAdvice)
    const sb = applyCalibrationToRankingScore(b.semantic, cheapAdvice)
    return (sb.ok ? sb.value : 0) - (sa.ok ? sa.value : 0)
  })
  check(reranked.length === candidates.length, 'calibrated reranking preserves the candidate count (it reorders, it does not filter)')
  const admittedAfter = reranked.filter(c => admitted.some(a => a.id === c.id))
  check(admittedAfter.length === 1 && admittedAfter[0].id === 'c-under', 'after calibrated reranking the budget-admitted set is byte-identical (calibration cannot admit an over-budget plan)')
}

// ---------------------------------------------------------------------------
// H. Ingestion seam
// ---------------------------------------------------------------------------
console.log('H. real-order ingestion seam: trigger frozen false, zero supplier records consulted')
check(OUTCOME_TRIGGER_FIRED === false, '#340 trigger gate frozen false')
check(LIVE_SUPPLIER_OUTCOME_SOURCES.length === 0, 'the supplier outcome source registry is frozen empty')
check(OUTCOME_PROJECTION_SCHEMA === 'gotry_outcome_projection.v1', 'schema id is versioned')

const deferred = await ingestSupplierOutcome({ attemptId: 'attempt-9f2', customerReferenceNo: 'ref-1' })
expectRefusal(deferred, 'trigger_deferred', 'zero supplier outcome sources consulted', 'before the trigger, ingestion refuses structurally')
check(!deferred.ok && deferred.detail.includes('fixtures, model self-reports and booking attempts do not count'), 'the refusal restates the #340 启动条件 (fixtures/self-reports/attempts are not a sale)')

let spyCalls = 0
const spySource: SupplierOutcomeSource = {
  id: 'spy-fixture-source',
  authorization_basis: 'test-only spy (no real authorization exists)',
  fetchOutcome: async () => {
    spyCalls++
    return { ok: true, observation: { idemKey: 'spy', status: 'confirmed', observedAt: T_BOOK } }
  },
}
const refusedWithSources = await ingestSupplierOutcome({ attemptId: 'a', customerReferenceNo: 'r' }, { sources: [spySource], triggerFired: false })
expectRefusal(refusedWithSources, 'trigger_deferred', 'trigger has not fired', 'even with sources supplied, the pre-trigger refusal happens before any read')
check(spyCalls === 0, 'fetch spy zero-call proof: zero supplier records consulted before the trigger fired')
const noSource = await ingestSupplierOutcome({ attemptId: 'a', customerReferenceNo: 'r' }, { sources: [], triggerFired: true })
expectRefusal(noSource, 'binding_incomplete', 'authorization_basis', 'trigger on + empty registry: no source is invented')
const viaSpy = await ingestSupplierOutcome({ attemptId: 'a', customerReferenceNo: 'r' }, { sources: [spySource], triggerFired: true })
check(viaSpy.ok && spyCalls === 1, 'the seam data shape is usable once a source is explicitly admitted (drill only)')

console.log(`\nOUTCOME PROJECTION CONTRACT TESTS (#340, simulated_trigger_drill / fixture_contract): ${passed} pass${process.exitCode ? ', FAIL' : ' (all green)'}`)
