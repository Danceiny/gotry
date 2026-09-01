import { readFileSync } from 'node:fs'
import { Ajv2020, type ValidateFunction } from 'ajv/dist/2020.js'
import { BOOKING_READ_ACTION_KINDS_V2, BOOKING_V2_BLOCKER_CODES, BOOKING_V2_GAP_CODES } from './contracts-v2.ts'

const schema = JSON.parse(readFileSync(new URL('../../../schemas/booking.surface.v2.schema.json', import.meta.url), 'utf8')) as Record<string, unknown>
const v1 = JSON.parse(readFileSync(new URL('../../../schemas/booking.surface.v1.schema.json', import.meta.url), 'utf8')) as Record<string, unknown>
const ajv = new Ajv2020({ allErrors: true, strict: true })
ajv.addSchema(v1)
ajv.addSchema(schema)
const validate: ValidateFunction = ajv.compile(schema)
const validateActionCanonical = ajv.compile({ $ref: `${schema.$id}#/$defs/Action` })
const validateBlockerCanonical = ajv.compile({ $ref: `${schema.$id}#/$defs/Blocker` })
const validateApprovalCanonical = ajv.compile({ $ref: `${schema.$id}#/$defs/Approval` })
const validateEventCanonical = ajv.compile({ $ref: `${schema.$id}#/$defs/Event` })
const kinds = new Set<string>(BOOKING_READ_ACTION_KINDS_V2)
const codes = new Set<string>(BOOKING_V2_BLOCKER_CODES)
const gapCodes = new Set<string>(BOOKING_V2_GAP_CODES)
const safeOpaque = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9:._-]*$/.test(value)
const secret = /(?:Bearer\s+\S|\bsk-(?!ill(?:s)?\b)[A-Za-z0-9_-]{12,}|\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)/i
// `.example` is reserved for documentation, so these identifiers cannot be a
// real mailbox. Do not allowlist lookalikes on routable domains.
const technicalEmail = /^(?:schema|version)@[a-z0-9-]+\.example$/i
const currencyAmount = /\b(?:[A-Z]{3}\s*\d+(?:\.\d+)?|\d+(?:\.\d+)?\s*[A-Z]{3})\b/

function normalizedWords(value: string): string {
  return value.normalize('NFKC').replace(/[^\p{L}\p{N}.]+/gu, ' ').trim()
}

function hasSupplierCost(value: string): boolean {
  const normalized = normalizedWords(value)
  const lower = normalized.toLowerCase()
  return (
    /\b(?:supplier|vendor|internal)\b/.test(lower) &&
    /\b(?:cost|rate|price)\b/.test(lower) &&
    currencyAmount.test(normalized.toUpperCase())
  )
}

function hasInternationalPhone(value: string): boolean {
  const normalized = value.normalize('NFKC')
  for (const plusIndex of normalized.split('').flatMap((char, index) => char === '+' ? [index] : [])) {
    let digits = ''
    for (const char of normalized.slice(plusIndex + 1, plusIndex + 48)) {
      if (/\d/u.test(char)) digits += char
      else if (/\p{L}|@/u.test(char)) break
      if (digits.length > 15) break
    }
    if (/^[1-9]\d{7,14}$/.test(digits)) return true
  }
  return false
}

function hasPaymentCard(value: string): boolean {
  const normalized = value.normalize('NFKC')
  const candidates = normalized.match(/(?:\d[ -]?){12,18}\d/g) ?? []
  const explicitlyLabeled = /\b(?:card|payment|visa|mastercard)\b/i.test(normalized)
  return candidates.some((candidate) => (explicitlyLabeled || /[ -]/.test(candidate)) && luhn(candidate))
}

function hasSensitiveText(value: string): boolean {
  const normalized = value.normalize('NFKC')
  if (normalized.includes('@') && !technicalEmail.test(normalized.trim())) return true
  return secret.test(normalized) || hasInternationalPhone(normalized) || hasSupplierCost(normalized) || hasPaymentCard(normalized)
}
function luhn(value: string): boolean { const digits = value.replaceAll(/\D/g, ''); if (digits.length < 13 || digits.length > 19) return false; let sum = 0; for (let i = digits.length - 1, parity = 0; i >= 0; i--, parity++) { let n = Number(digits[i]); if (parity % 2 === 1) { n *= 2; if (n > 9) n -= 9 } sum += n } return sum % 10 === 0 }
const scan = (v: unknown): boolean => typeof v === 'string' ? hasSensitiveText(v) : Array.isArray(v) ? v.some(scan) : !!v && typeof v === 'object' ? Object.entries(v).some(([k,x]) => /cost|price/i.test(k) ? /supplier|internal|wholesale/i.test(String(x)) : scan(x)) : false
export type BookingSurfaceV2ValidationResult = { ok: true } | { ok: false; errors: string[] }
function errors(v: ValidateFunction): string[] { return (v.errors ?? []).map(e => `${e.instancePath || '$'}: ${e.message ?? e.keyword}`) }
function cross(value: unknown): string[] {
  const e: string[] = []
  if (scan(value)) e.push('$: unsafe PII/payment/supplier-cost/credential text')
  if (!value || typeof value !== 'object' || Array.isArray(value)) return e
  const x = value as Record<string, any>
  const semantic = x.kind === 'action.receipt.continuation' ? x.receipt : x
  if (semantic !== x && semantic?.resultContract?.hardCriteriaMet === true && semantic.resultContract.blockers?.length) e.push('$.receipt.resultContract: hardCriteriaMet cannot coexist with blockers')
  if (kinds.has(x.kind)) {
    const allowed: Record<string, string[]> = {
      'search.patch': ['patch'], 'search.run': [], 'results.view.patch': ['patch'],
      'hotel.focus': ['hotelRef'], 'hotel.select': ['hotelRef'],
      'offers.query': ['hotelRefs', 'criteria'], 'offers.view.patch': ['hotelRef', 'criteria'],
      'offers.compare': ['offerRefs', 'requestedCount'], 'offer.select': ['offerRef'],
      'offer.check': ['offerRef'], 'checkout.prepare': ['offerRef', 'verifiedOfferRef'], 'order.observe': ['orderRef'],
    }
    const input = x.input
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(k => !allowed[x.kind].includes(k))) e.push('$.input: closed kind-specific input required')
  }
  if (x.kind === 'action.receipt' && x.resultContract?.hardCriteriaMet === true && x.resultContract.blockers?.length) e.push('$.resultContract: hardCriteriaMet cannot coexist with blockers')
  if (x.kind === 'user.turn' && Array.isArray(x.request?.approval)) e.push('$.request.approval: at most one approval')
  if (x.kind === 'action.receipt' || x.kind === 'action.receipt.continuation') {
    const r = x.kind === 'action.receipt.continuation' ? x.receipt : x
    if (r?.resultContract?.gapCodes?.some((code: unknown) => !gapCodes.has(String(code)))) e.push('$.resultContract.gapCodes: unregistered gap code')
  }
  const blocker = x.blocker ?? x.question?.blocker
  if (blocker && !/^(searchDraft|results|offers|checkout)(\.[A-Za-z][A-Za-z0-9_]*){0,3}$/.test(blocker.criterionPath ?? '')) e.push('$.blocker.criterionPath: closed criterion path required')
  if (blocker?.evidence?.factRefs && new Set(blocker.evidence.factRefs).size !== blocker.evidence.factRefs.length) e.push('$.blocker.evidence.factRefs: unique refs required')
  if (x.kind === 'question' && blocker && Array.isArray(x.question?.approvalOptions)) {
    for (const [i, option] of x.question.approvalOptions.entries()) {
      const result = validateApprovalAgainstBlocker(option?.approval, blocker)
      if (!result.ok) e.push(...result.errors.map(error => `$.question.approvalOptions[${i}].${error.slice(2)}`))
    }
  }
  if (kinds.has(String(x.kind)) && x.relaxationApprovalRef) {
    const ref = x.relaxationApprovalRef
    if (ref.contextRef !== x.contextRef) e.push('$.relaxationApprovalRef.contextRef: must match action')
    if (ref.sourceRevision !== x.expectedRevision) e.push('$.relaxationApprovalRef.sourceRevision: must equal action revision')
    if (ref.targetActionKind !== x.kind) e.push('$.relaxationApprovalRef.targetActionKind: must match action kind')
    if (ref.targetActionId !== x.actionId) e.push('$.relaxationApprovalRef.targetActionId: must match action id')
    // Expiry and one-time consumption are Phase B runtime concerns; Phase A validates only structure/binding.
    if (!safeOpaque(ref.nonce) || Number.isNaN(Date.parse(ref.expiresAt))) e.push('$.relaxationApprovalRef: invalid expiry or nonce')
  }
  if (x.kind === 'question' && (!Array.isArray(x.question?.approvalOptions) || x.question.approvalOptions.length < 1 || x.question.approvalOptions.length > 2)) e.push('$.question.approvalOptions: one or two options required')
  return e
}
export function validateBookingSurfaceV2(value: unknown): BookingSurfaceV2ValidationResult { const ok = validate(value); const e = ok ? [] : errors(validate); e.push(...cross(value)); return e.length ? { ok: false, errors: e } : { ok: true } }
function fromCanonical(fn: ValidateFunction, value: unknown): BookingSurfaceV2ValidationResult { const ok = fn(value); const e = ok ? [] : errors(fn); e.push(...cross(value)); return e.length ? { ok: false, errors: e } : { ok: true } }
export function validateBookingReadActionV2(value: unknown): BookingSurfaceV2ValidationResult { return fromCanonical(validateActionCanonical, value) }
export function validateCriterionBlockerV2(value: unknown): BookingSurfaceV2ValidationResult { return fromCanonical(validateBlockerCanonical, value) }
export function validateRelaxationApprovalV2(value: unknown): BookingSurfaceV2ValidationResult { return fromCanonical(validateApprovalCanonical, value) }
export function validateBookingSurfaceEventV2(value: unknown): BookingSurfaceV2ValidationResult { return fromCanonical(validateEventCanonical, value) }
export function validateApprovalAgainstBlocker(approval: unknown, blocker: unknown): BookingSurfaceV2ValidationResult {
  const a = approval as any
  const b = blocker as any
  const blockerResult = validateCriterionBlockerV2(b)
  if (!blockerResult.ok) return blockerResult
  const approvalResult = validateRelaxationApprovalV2(a)
  if (!approvalResult.ok) return approvalResult
  const fields = ['blockerId', 'sourceActionId', 'sourceReceiptDigest', 'scope', 'code', 'criterionPath', 'valueDigest']
  const mismatches = fields.filter(field => a[field] !== b?.[field])
  return mismatches.length ? { ok: false, errors: mismatches.map(field => `$.${field}: approval does not match blocker`) } : { ok: true }
}
