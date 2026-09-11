/**
 * Cancel/refund independent outcomes + explicit commission disclosure
 * (issue #233, M5-4 pre-entry contract layer; parent #136).
 *
 * Contract only: pure types + pure functions. Zero network, zero subprocess,
 * zero ledger/schema change, zero supplier call surface — the write path stays
 * sealed behind #136 M5 Entry; receipt/outbox/dispatch authority belongs to
 * #231/#232 and is deliberately NOT modeled here.
 *
 * Frozen sources of truth:
 * - docs/design/write-gate-production-design.md §3 (SupplierOutcome closed set),
 *   §4 (commission_disclosure digest enters the request fingerprint; a
 *   disclosure change invalidates the old receipt), §7 (outcome × user copy
 *   matrix), §8 (cancellation / refund order / wallet refund are separate
 *   outcomes; cancel.serviceFee is not the customer refund amount; pending →
 *   compensated cancels only the local suggestion and never means "refunded"),
 *   §10 (commission/sponsorship disclosure before confirmation; unknown must
 *   not default to none), §11 (redaction);
 * - docs/design/fact-writegate-seam.md §2.3 (wording authority per claim type:
 *   "cancellation requested" only; refunded only from authoritative evidence).
 *
 * Default-off: nothing in this module is wired into any runtime path. The
 * focused suite ts/scripts/issue-233-cancel-refund-commission-tests.ts pins
 * the contract (run-all §62).
 */

import { createHash } from 'node:crypto'

// ---- 1. Independent outcome closed sets -----------------------------------------

export const CANCELLATION_OUTCOME_SCHEMA = 'gotry.cancellation_outcome.v1' as const
/** Cancel REQUEST outcome. There is deliberately no "cancelled" terminal here:
 * only an explicit supplier cancellation receipt (supplierCancellationConfirmed)
 * upgrades a submission into a confirmed cancellation. */
export const CANCELLATION_STATUSES = ['not_requested', 'cancel_submitted', 'cancel_failed', 'cancel_unknown'] as const
export type CancellationStatus = (typeof CANCELLATION_STATUSES)[number]

export const REFUND_OUTCOME_SCHEMA = 'gotry.refund_outcome.v1' as const
/** Money-arrival outcome. Independent from the cancellation outcome by design:
 * the two objects are never merged into a single success state. */
export const REFUND_STATUSES = ['not_applicable', 'refund_pending', 'refund_failed', 'refunded', 'refund_unknown'] as const
export type RefundStatus = (typeof REFUND_STATUSES)[number]

/** ADR-17 ledger alphabet, mirrored read-only for copy consistency checks.
 * This module does not touch the ledger (that is #231's surface). */
export const LOCAL_LEDGER_STATUSES = ['pending', 'confirmed', 'compensated'] as const
export type LocalLedgerStatus = (typeof LOCAL_LEDGER_STATUSES)[number]

/** Refund amount may only be concluded from authoritative refund/wallet records. */
export const REFUND_AUTHORITY_SOURCES = ['supplier_refund_record', 'wallet_refund_record'] as const
export type RefundAuthoritySource = (typeof REFUND_AUTHORITY_SOURCES)[number]
/** The supplier cancellation fee is a separate disclosure; it is never a refund amount. */
export const SERVICE_FEE_SOURCE = 'cancel_return_service_fee' as const

/** supplierReferenceNo is used only as a supplier-returned value — never decoded
 * or guessed from customerReferenceNo (write-gate design §2/§6). The only way to
 * construct one is `supplierReferenceNoFromReturn` with an explicit return source. */
export const SUPPLIER_REFERENCE_RETURN_SOURCES = ['supplier_cancel_return', 'supplier_query_return', 'supplier_refund_return'] as const
export type SupplierReferenceReturnSource = (typeof SUPPLIER_REFERENCE_RETURN_SOURCES)[number]

export interface SupplierReferenceNo {
  readonly value: string
  readonly source: SupplierReferenceReturnSource
}

export function supplierReferenceNoFromReturn(value: string, source: SupplierReferenceReturnSource): { ok: true; value: SupplierReferenceNo } | { ok: false; reason: string } {
  const trimmed = typeof value === 'string' ? value.trim() : ''
  if (trimmed === '') return { ok: false, reason: 'supplier_reference_empty' }
  if (!(SUPPLIER_REFERENCE_RETURN_SOURCES as readonly string[]).includes(source)) return { ok: false, reason: 'supplier_reference_not_returned_value' }
  return { ok: true, value: Object.freeze({ value: trimmed, source }) }
}

export interface MoneyAmount {
  readonly amount: string
  readonly currency: string
  /** Where this number is authoritative from (refund authorities only for customerRefund). */
  readonly source: string
}

export interface RefundEvidence {
  readonly kind: RefundAuthoritySource
  readonly digest: string
}

export interface CancellationOutcome {
  readonly schema: typeof CANCELLATION_OUTCOME_SCHEMA
  readonly status: CancellationStatus
  readonly customerReferenceNo: string
  readonly supplierReferenceNo?: SupplierReferenceNo
  /** Explicit supplier cancellation receipt; its presence (and only it) allows
   * "cancelled" wording. Requested-but-unconfirmed stays orderCancelled=unknown. */
  readonly supplierCancellationConfirmed?: { readonly digest: string }
  readonly evidenceDigest?: string
  readonly observedAt: string
}

export interface RefundOutcome {
  readonly schema: typeof REFUND_OUTCOME_SCHEMA
  readonly status: RefundStatus
  /** Customer refund amount — only from REFUND_AUTHORITY_SOURCES; never the cancel serviceFee. */
  readonly customerRefund?: MoneyAmount
  /** Supplier-side cancellation fee, disclosed separately; not the refund. */
  readonly supplierServiceFee?: { readonly amount: string; readonly currency: string }
  /** Arrival conclusion binds authoritative evidence; `refunded` requires it. */
  readonly evidence?: RefundEvidence
  readonly reasonCode?: string
  readonly observedAt: string
}

const AMOUNT_RE = /^\d+(\.\d+)?$/
function nonEmpty(v: unknown): v is string {
  return typeof v === 'string' && v.trim() !== ''
}
function validAmount(v: unknown): v is string {
  return nonEmpty(v) && AMOUNT_RE.test(v.trim())
}

export type ContractResult<T> = { ok: true; value: T } | { ok: false; reason: string }

export function cancellationOutcome(input: CancellationOutcome): ContractResult<CancellationOutcome> {
  if (input?.schema !== CANCELLATION_OUTCOME_SCHEMA) return { ok: false, reason: 'schema_mismatch' }
  if (!(CANCELLATION_STATUSES as readonly string[]).includes(input.status)) return { ok: false, reason: 'unknown_cancellation_status' }
  if (!nonEmpty(input.customerReferenceNo)) return { ok: false, reason: 'customer_reference_required' }
  if (input.supplierReferenceNo !== undefined) {
    const r = input.supplierReferenceNo
    if (!nonEmpty(r?.value) || !(SUPPLIER_REFERENCE_RETURN_SOURCES as readonly string[]).includes(r?.source)) {
      return { ok: false, reason: 'supplier_reference_not_returned_value' }
    }
  }
  if (input.supplierCancellationConfirmed !== undefined && !nonEmpty(input.supplierCancellationConfirmed?.digest)) {
    return { ok: false, reason: 'supplier_cancellation_receipt_digest_required' }
  }
  if (!nonEmpty(input.observedAt)) return { ok: false, reason: 'observed_at_required' }
  return { ok: true, value: Object.freeze({ ...input }) }
}

export function refundOutcome(input: RefundOutcome): ContractResult<RefundOutcome> {
  if (input?.schema !== REFUND_OUTCOME_SCHEMA) return { ok: false, reason: 'schema_mismatch' }
  if (!(REFUND_STATUSES as readonly string[]).includes(input.status)) return { ok: false, reason: 'unknown_refund_status' }
  if (!nonEmpty(input.observedAt)) return { ok: false, reason: 'observed_at_required' }
  if (input.customerRefund !== undefined) {
    const cr = input.customerRefund
    if (!validAmount(cr?.amount) || !nonEmpty(cr?.currency)) return { ok: false, reason: 'refund_amount_invalid' }
    if (cr.source === SERVICE_FEE_SOURCE) return { ok: false, reason: 'service_fee_used_as_refund_amount' }
  }
  if (input.status === 'refunded') {
    const authoritative =
      input.customerRefund !== undefined &&
      (REFUND_AUTHORITY_SOURCES as readonly string[]).includes(input.customerRefund.source) &&
      input.evidence !== undefined &&
      (REFUND_AUTHORITY_SOURCES as readonly string[]).includes(input.evidence?.kind) &&
      nonEmpty(input.evidence?.digest)
    if (!authoritative) return { ok: false, reason: 'refund_claimed_without_evidence' }
  }
  if (input.supplierServiceFee !== undefined && (!validAmount(input.supplierServiceFee?.amount) || !nonEmpty(input.supplierServiceFee?.currency))) {
    return { ok: false, reason: 'service_fee_invalid' }
  }
  return { ok: true, value: Object.freeze({ ...input }) }
}

// ---- 2. Aftercare facts (never one merged status) --------------------------------

export interface AftercareFacts {
  /** A cancellation request was submitted to the supplier. */
  readonly cancellationRequested: boolean
  /** true only with an explicit supplier cancellation receipt; false on
   * cancel_failed; 'unknown' while submitted-but-unconfirmed (requested ≠ cancelled). */
  readonly orderCancelled: boolean | 'unknown'
  /** true only on evidenced refunded; 'unknown' while pending/unknown. */
  readonly moneyReturned: boolean | 'unknown'
  readonly refundStatus: RefundStatus
}

export function aftercareFacts(cancel: CancellationOutcome, refund: RefundOutcome): AftercareFacts {
  return Object.freeze({
    cancellationRequested: cancel.status === 'cancel_submitted',
    orderCancelled:
      cancel.supplierCancellationConfirmed !== undefined
        ? true
        : cancel.status === 'cancel_failed'
          ? false
          : 'unknown',
    moneyReturned:
      refund.status === 'refunded'
        ? true
        : refund.status === 'refund_failed' || refund.status === 'not_applicable'
          ? false
          : 'unknown',
    refundStatus: refund.status,
  })
}

// ---- 3. Commission / sponsorship disclosure --------------------------------------

export const COMMISSION_DISCLOSURE_SCHEMA = 'gotry.commission_disclosure.v1' as const
export const COMMISSION_BENEFIT_KINDS = ['commission', 'rebate', 'sponsorship', 'preferred_placement'] as const
export type CommissionBenefitKind = (typeof COMMISSION_BENEFIT_KINDS)[number]
export const COMMISSION_CERTAINTIES = ['known_benefit', 'known_none', 'unknown'] as const
export type CommissionCertainty = (typeof COMMISSION_CERTAINTIES)[number]
export const COMMISSION_SOURCES = ['supplier_field', 'contract_rule'] as const
export type CommissionSource = (typeof COMMISSION_SOURCES)[number]
export const COMMISSION_AMOUNT_BASES = ['fixed', 'percent_of_total', 'per_night'] as const
export type CommissionAmountBasis = (typeof COMMISSION_AMOUNT_BASES)[number]

const PAID_BY = ['supplier', 'distributor', 'customer'] as const
export type CommissionPaidBy = (typeof PAID_BY)[number]

export interface CommissionBenefit {
  readonly kind: CommissionBenefitKind
  readonly paidBy: CommissionPaidBy
  /** Recipient as an HMAC pseudonym or 'gotry'; never a raw name (§11 redaction). */
  readonly paidTo: string
  readonly basis: {
    readonly type: CommissionAmountBasis
    readonly amount?: string
    readonly percent?: string
    readonly currency?: string
  }
}

export interface CommissionDisclosure {
  readonly schema: typeof COMMISSION_DISCLOSURE_SCHEMA
  readonly certainty: CommissionCertainty
  readonly benefits: readonly CommissionBenefit[]
  readonly source: CommissionSource
}

export const COMMISSION_VIOLATION_CODES = [
  'commission_undisclosed',
  'commission_none_without_source',
  'commission_benefit_incomplete',
  'commission_amount_basis_inconsistent',
  'disclosure_digest_mismatch',
] as const
export type CommissionViolationCode = (typeof COMMISSION_VIOLATION_CODES)[number]

const POSITIVE_NUMBER_RE = /^(0*[1-9][0-9]*(\.[0-9]+)?|0*\.[0-9]*[1-9][0-9]*)$/

export function validateCommissionDisclosure(v: unknown): { ok: true } | { ok: false; violations: CommissionViolationCode[] } {
  if (typeof v !== 'object' || v === null || (v as CommissionDisclosure).schema !== COMMISSION_DISCLOSURE_SCHEMA) {
    return { ok: false, violations: ['commission_undisclosed'] }
  }
  const d = v as CommissionDisclosure
  if (!(COMMISSION_CERTAINTIES as readonly string[]).includes(d.certainty)) return { ok: false, violations: ['commission_undisclosed'] }
  if (!(COMMISSION_SOURCES as readonly string[]).includes(d.source)) return { ok: false, violations: ['commission_benefit_incomplete'] }
  const violations: CommissionViolationCode[] = []
  if (!Array.isArray(d.benefits)) return { ok: false, violations: ['commission_benefit_incomplete'] }
  if (d.certainty === 'known_none' || d.certainty === 'unknown') {
    if (d.benefits.length > 0) violations.push('commission_benefit_incomplete')
    if (d.certainty === 'known_none' && d.source !== 'contract_rule') violations.push('commission_none_without_source')
  }
  if (d.certainty === 'known_benefit') {
    if (d.benefits.length === 0) violations.push('commission_benefit_incomplete')
  }
  for (const b of d.benefits) {
    if (
      !(COMMISSION_BENEFIT_KINDS as readonly string[]).includes(b?.kind) ||
      !(PAID_BY as readonly string[]).includes(b?.paidBy) ||
      !nonEmpty(b?.paidTo)
    ) {
      violations.push('commission_benefit_incomplete')
      continue
    }
    const basis = b.basis
    if (!(COMMISSION_AMOUNT_BASES as readonly string[]).includes(basis?.type)) {
      violations.push('commission_amount_basis_inconsistent')
      continue
    }
    if (basis.type === 'percent_of_total') {
      const okPercent = validAmount(basis.percent) && POSITIVE_NUMBER_RE.test(basis.percent.trim()) && basis.amount === undefined
      if (!okPercent) violations.push('commission_amount_basis_inconsistent')
    } else {
      const okFixed = validAmount(basis.amount) && nonEmpty(basis.currency) && basis.percent === undefined
      if (!okFixed) violations.push('commission_amount_basis_inconsistent')
    }
  }
  return violations.length === 0 ? { ok: true } : { ok: false, violations }
}

/** Canonical JSON (sorted keys, stable) — local to keep this module dependency-free. */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const obj = value as Record<string, unknown>
  return `{${Object.keys(obj)
    .sort()
    .map(key => `${JSON.stringify(key)}:${canonicalJson(obj[key])}`)
    .join(',')}}`
}

export function computeDisclosureDigest(disclosure: CommissionDisclosure): string {
  return createHash('sha256')
    .update(canonicalJson({ schema: disclosure.schema, certainty: disclosure.certainty, benefits: disclosure.benefits, source: disclosure.source }))
    .digest('hex')
}

/** Confirmation boundary: no disclosure object at all is a hard reject — a card
 * may not be confirmed without explicit commission disclosure (§10). */
export function disclosureForConfirmation(v: unknown): { ok: true; disclosure: CommissionDisclosure; digest: string } | { ok: false; violation: CommissionViolationCode } {
  const checked = validateCommissionDisclosure(v)
  if (!checked.ok) return { ok: false, violation: checked.violations[0] }
  const disclosure = v as CommissionDisclosure
  return { ok: true, disclosure, digest: computeDisclosureDigest(disclosure) }
}

/** The request-fingerprint field carrying the disclosure digest (design §4). */
export const COMMISSION_DISCLOSURE_FINGERPRINT_FIELD = 'commission_disclosure' as const

export function bindDisclosureToFingerprint(
  fingerprint: Record<string, unknown>,
  disclosure: CommissionDisclosure,
): { ok: true; fingerprint: Record<string, unknown>; digest: string } | { ok: false; violation: Extract<CommissionViolationCode, 'disclosure_digest_mismatch'> } {
  const digest = computeDisclosureDigest(disclosure)
  const existing = fingerprint[COMMISSION_DISCLOSURE_FINGERPRINT_FIELD]
  if (typeof existing === 'string' && existing !== digest) {
    // Disclosure caliber changed after confirmation: the old receipt is invalid;
    // re-confirmation against the new disclosure is required.
    return { ok: false, violation: 'disclosure_digest_mismatch' }
  }
  return { ok: true, fingerprint: { ...fingerprint, [COMMISSION_DISCLOSURE_FINGERPRINT_FIELD]: digest }, digest }
}

// ---- 4. User copy: ledger tokens and copy tokens stay consistent -----------------

export type AftercareCopyLocale = 'en' | 'zh-CN'

/** Arrival claims. If copy states these while the outcome is not an evidenced
 * `refunded`, the wording contradicts the ledger-side tokens. */
const ARRIVAL_TOKENS: Record<AftercareCopyLocale, readonly string[]> = {
  en: ['refunded', 'refund received', 'refund has arrived'],
  'zh-CN': ['已退款', '退款已到账', '退款到账'],
}
const CANCEL_DONE_TOKENS: Record<AftercareCopyLocale, readonly string[]> = {
  en: ['cancelled'],
  'zh-CN': ['已取消'],
}
const BENEFIT_MARKERS: Record<AftercareCopyLocale, readonly string[]> = {
  en: ['commission', 'rebate', 'sponsorship', 'preferred placement'],
  'zh-CN': ['佣金', '返利', '赞助', '优先位'],
}
/** A definite benefit claim (only allowed when certainty='known_benefit'). */
const DEFINITE_BENEFIT_TOKENS: Record<AftercareCopyLocale, readonly string[]> = {
  en: ['paid by', '% of total'],
  'zh-CN': ['支付给', '%'],
}

const ZH_BENEFIT_KIND: Record<CommissionBenefitKind, string> = {
  commission: '佣金',
  rebate: '返利',
  sponsorship: '赞助',
  preferred_placement: '优先位',
}

export const COPY_VIOLATION_CODES = [
  'copy_claimed_cancelled_without_supplier_evidence',
  'copy_claimed_refund_arrival_without_authority',
  'copy_refund_wording_while_pending_or_unknown',
  'copy_refund_wording_on_local_compensation_only',
  'commission_disclosure_missing_from_summary',
  'commission_status_contradicts_summary',
] as const
export type CopyViolationCode = (typeof COPY_VIOLATION_CODES)[number]

export function localLedgerCopy(status: LocalLedgerStatus, locale: AftercareCopyLocale): string {
  if (locale === 'zh-CN') {
    if (status === 'pending') return '本地建议待确认；未下单。'
    if (status === 'confirmed') return '本地已确认授权；供应商结果待回执。'
    return '本地账面已补偿；这只是账务动作，退款状态以退款结果为准。'
  }
  if (status === 'pending') return 'Local suggestion pending confirmation; no order placed.'
  if (status === 'confirmed') return 'Confirmed and authorized locally; supplier outcome pending receipt.'
  return 'Compensated locally; this is a ledger action only — refund state is tracked by the refund outcome.'
}

function basisLabel(basis: CommissionBenefit['basis'], locale: AftercareCopyLocale): string {
  if (basis.type === 'percent_of_total') return locale === 'zh-CN' ? `总价 ${basis.percent}%` : `${basis.percent}% of total`
  if (basis.type === 'per_night') return locale === 'zh-CN' ? `每晚 ${basis.amount} ${basis.currency}` : `${basis.amount} ${basis.currency} per night`
  return locale === 'zh-CN' ? `固定 ${basis.amount} ${basis.currency}` : `${basis.amount} ${basis.currency} fixed`
}

function disclosureLines(disclosure: CommissionDisclosure, locale: AftercareCopyLocale): string[] {
  const zh = locale === 'zh-CN'
  if (disclosure.certainty === 'unknown') return [zh ? '佣金/返利/赞助披露：未知（不默认没有）。' : 'Commission/sponsorship disclosure: unknown (not assumed none).']
  if (disclosure.certainty === 'known_none') return [zh ? '佣金/返利/赞助披露：无（依据合同规则记录）。' : 'Commission/sponsorship disclosure: none (source: contract rule).']
  return disclosure.benefits.map(b =>
    zh
      ? `${ZH_BENEFIT_KIND[b.kind]}：由 ${b.paidBy} 支付给 ${b.paidTo}，口径 ${basisLabel(b.basis, locale)}。`
      : `${b.kind.replaceAll('_', ' ')}: paid by ${b.paidBy} to ${b.paidTo} — ${basisLabel(b.basis, locale)}.`,
  )
}

export function renderAftercareCopy(
  cancel: CancellationOutcome,
  refund: RefundOutcome,
  ledgerStatus: LocalLedgerStatus,
  disclosure: CommissionDisclosure | undefined,
  locale: AftercareCopyLocale,
): string {
  const zh = locale === 'zh-CN'
  const lines: string[] = [localLedgerCopy(ledgerStatus, locale)]
  if (cancel.supplierCancellationConfirmed !== undefined) {
    lines.push(zh ? '供应商回执确认已取消（证据摘要已留存）。' : 'Cancelled per supplier receipt (evidence digest on file).')
  } else if (cancel.status === 'not_requested') {
    lines.push(zh ? '未申请取消。' : 'No cancellation requested.')
  } else if (cancel.status === 'cancel_submitted') {
    lines.push(zh ? '已提交取消申请；等待供应商确认。' : 'Cancellation requested/submitted; awaiting supplier confirmation.')
  } else if (cancel.status === 'cancel_failed') {
    lines.push(zh ? '取消失败。' : 'Cancellation failed.')
  } else {
    lines.push(zh ? '取消结果未知；对账中。' : 'Cancellation outcome unknown; reconciling.')
  }
  if (refund.status === 'not_applicable') {
    lines.push(zh ? '不涉及退款。' : 'No refund involved.')
  } else if (refund.status === 'refund_pending') {
    lines.push(zh ? '退款处理中；尚未到账。' : 'Refund pending; not yet arrived.')
  } else if (refund.status === 'refund_failed') {
    lines.push(zh ? '退款失败；未到账。' : 'Refund failed; the refund did not arrive.')
  } else if (refund.status === 'refund_unknown') {
    lines.push(zh ? '退款结果未知；对账中。' : 'Refund outcome unknown; reconciling.')
  } else {
    lines.push(
      zh
        ? `退款已到账：${refund.customerRefund?.amount} ${refund.customerRefund?.currency}（依据 ${refund.evidence?.kind}）。`
        : `Refund received: ${refund.customerRefund?.amount} ${refund.customerRefund?.currency} per ${refund.evidence?.kind}.`,
    )
  }
  if (refund.supplierServiceFee !== undefined) {
    lines.push(
      zh
        ? `供应商取消手续费（供应商收取，不是退款金额）：${refund.supplierServiceFee.amount} ${refund.supplierServiceFee.currency}。`
        : `Supplier cancellation service fee (charged by supplier, not the refund): ${refund.supplierServiceFee.amount} ${refund.supplierServiceFee.currency}.`,
    )
  }
  if (disclosure !== undefined) lines.push(...disclosureLines(disclosure, locale))
  return lines.join('\n')
}

export interface CopyCheckState {
  readonly cancel: CancellationOutcome
  readonly refund: RefundOutcome
  readonly ledgerStatus: LocalLedgerStatus
  readonly disclosure: CommissionDisclosure | undefined
  readonly locale: AftercareCopyLocale
}

/** Mechanical token gate: copy shown to the user must not claim states the
 * outcome objects (and the ledger mirror) do not carry, and must not hide the
 * commission disclosure behind a total price. This is a regression anchor for
 * generated/hand-written/LLM copy — not an NLU claim. */
export function copyTokenViolations(text: string, state: CopyCheckState): CopyViolationCode[] {
  const violations: CopyViolationCode[] = []
  const zh = state.locale === 'zh-CN'
  const hay = zh ? text : text.toLowerCase()
  const has = (tokens: readonly string[]): boolean => tokens.some(t => hay.includes(t))
  const arrival = ARRIVAL_TOKENS[state.locale]
  const cancelDone = CANCEL_DONE_TOKENS[state.locale]

  if (state.cancel.supplierCancellationConfirmed === undefined && has(cancelDone)) {
    violations.push('copy_claimed_cancelled_without_supplier_evidence')
  }
  if (state.refund.status !== 'refunded' && has(arrival)) {
    violations.push('copy_claimed_refund_arrival_without_authority')
    if (state.refund.status === 'refund_pending' || state.refund.status === 'refund_unknown') {
      violations.push('copy_refund_wording_while_pending_or_unknown')
    }
  }
  if (state.ledgerStatus === 'compensated' && state.refund.status === 'not_applicable' && has(arrival)) {
    violations.push('copy_refund_wording_on_local_compensation_only')
  }
  const d = state.disclosure
  if (d !== undefined) {
    if (d.certainty === 'known_benefit') {
      if (!has(BENEFIT_MARKERS[state.locale])) violations.push('commission_disclosure_missing_from_summary')
    } else {
      const required =
        d.certainty === 'unknown'
          ? zh
            ? hay.includes('佣金') && hay.includes('未知')
            : hay.includes('commission') && hay.includes('unknown')
          : zh
            ? hay.includes('无（依据')
            : hay.includes('none')
      if (!required) violations.push('commission_disclosure_missing_from_summary')
      if (has(DEFINITE_BENEFIT_TOKENS[state.locale])) violations.push('commission_status_contradicts_summary')
    }
  }
  return violations
}
