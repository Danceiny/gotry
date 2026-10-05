/**
 * Provider fault-detail sanitizer (shared, pure, zero imports).
 *
 * A provider's failure text is a LABEL for operators, never a channel for a
 * provider response body. Any string that may reach the evidence/verdict surface
 * passes through `sanitizeFaultDetail` first: markup, credential assignments and
 * URLs are redacted, whitespace is collapsed, and the result is length-bounded.
 * `faultDetailLeak` is the mechanical check a gate (or a test) can run over a
 * string that is about to be exposed.
 *
 * Extracted so that exactly one implementation serves both
 * `ts/capabilities/route-provider-conformance.ts` (the #429 conformance gate,
 * which re-exports it) and `ts/capabilities/ground-transfer.ts` (the live
 * product path, issue #429 GAP-429-3 fix). Keeping it in its own file means the
 * conformance gate itself stays free of product callers.
 *
 * Deliberately pure: zero imports, zero IO, zero network, zero clock.
 *
 * @module capabilities/provider-detail-sanitize
 */

/** Default bound for a provider fragment embedded in a gate refusal. */
export const FAULT_DETAIL_MAX_CHARS = 120

const DETAIL_SCRUB_PATTERNS: Array<{ re: RegExp; label: string }> = [
  { re: /<[^>]*>/g, label: 'markup' },
  { re: /\b(?:cookie|set-cookie|authorization|api[_-]?key|token|secret|password|passwd|sid)\s*[:=]\s*\S+/gi, label: 'credential' },
  { re: /\bbearer\s+[A-Za-z0-9._-]{8,}/gi, label: 'credential' },
  { re: /https?:\/\/\S+/gi, label: 'url' },
]

/**
 * Sanitize a provider fault detail.
 *
 * `maxChars` lets a caller keep its own historical bound (ground-transfer keeps
 * 400 so no existing `fallbackReason` text changes); `emptyPlaceholder` lets a
 * caller keep its own historical empty-case wording.
 */
export function sanitizeFaultDetail(
  detail: unknown,
  options?: { maxChars?: number; emptyPlaceholder?: string },
): string {
  const maxChars = options?.maxChars ?? FAULT_DETAIL_MAX_CHARS
  const placeholder = options?.emptyPlaceholder ?? '(no detail)'
  let text = typeof detail === 'string' ? detail : ''
  for (const { re, label } of DETAIL_SCRUB_PATTERNS) text = text.replace(re, `[${label}-redacted]`)
  text = text.replace(/\s+/g, ' ').trim()
  if (text.length > maxChars) text = `${text.slice(0, maxChars - 1)}…`
  return text === '' ? placeholder : text
}

/**
 * Mechanical leak check for any string about to reach the evidence surface.
 *
 * Shape-only by design: it looks for provider-response-body tells (markup,
 * credential assignments, URLs) and deliberately does NOT bound length — the
 * length bound belongs to `sanitizeFaultDetail`, which caps the PROVIDER
 * fragment, whereas a gate's own refusal explanation is host-authored prose and
 * may legitimately be longer.
 */
export function faultDetailLeak(detail: string): string | null {
  if (/<[^>]*>/.test(detail)) return 'fault detail carries markup (a provider response body must never reach the evidence surface)'
  if (/\b(?:cookie|authorization|api[_-]?key|token|secret|password|passwd|sid)\s*[:=]\s*\S+/i.test(detail)) return 'fault detail carries a credential assignment'
  if (/https?:\/\//i.test(detail)) return 'fault detail carries a URL'
  return null
}
