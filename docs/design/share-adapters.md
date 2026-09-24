[English](share-adapters.md) | [简体中文](share-adapters.zh-CN.md)

# Share Adapters and Share Token (issue #573)

> Role: the contract vocabulary, default-stub implementations, HMAC share-token, consent state machine, and main shareDeck flow that together define the outbound-share seam — all contracts and stubs, **no SDK call, no dsh tool registration, no runtime activation**.
> Status: internal slice (2026-09-23). Phase C of the karpo-deck-web borrowing roadmap. Runtime activation (real adapter wiring, dsh tool registration, trigger wiring) is M4 work and out of scope here.
> Upstream: issue #573; research decision §3 Phase C of [karpo-deck-web research](../research/karpo-deck-web-research.md); borrowing decision borrowed from the same source as the single-page HTML renderer — share requires the same "explicit, audit-able, never-on-the-sly" discipline as artifact entry; the consent pattern borrows shape from `ts/capabilities/session-consent.ts` but stays an independent module (session = "may I read your browser?"; share = "may I send to a third party on your behalf?" — distinct semantics and revocation granularity).
> Downstream: `ts/scripts/share-tests.ts` (run-all §6h); future M4 slices (trigger-driven outbound, dsh tool registration, real adapter SDK integration).

## TL;DR

- `ShareAdapter` interface with 4 no-op stubs (`imessage` / `sms` / `slack` / `webhook`) — all return `{ delivered: false, reason: 'not_activated' }`. No SDK, no network, no side effects.
- HMAC-SHA256 share-token: `signShareToken` / `verifyShareToken` — base64url body + sig, `timingSafeEqual` on verify, ttl expiry check, structured failure reasons.
- `ShareConsentState` machine with `mode: 'ask' | 'allow' | 'off'`, per-`share_id` cards, `revoked` list, `consent_required` vs `consent_revoked` distinguished explicitly.
- `shareDeck(token, payload, deps)` — pure async orchestration: token → consent → channel → adapter. Never throws. Always returns `ShareResult`.
- 8-class `ShareFailureReason` closed set; `not_activated`, `unknown_channel`, `consent_required`, `consent_revoked`, `share_consent_off`, `token_invalid`, `token_expired` — every class is reachable in tests.

## 1. Contract

```ts
export type ShareChannel = 'imessage' | 'sms' | 'slack' | 'webhook'

export interface SharePayload {
  token: string  // signed by share-token.ts
  target: { channel: ShareChannel; address: string }
  body: { html_path?: string; manifest_path?: string; qr_path?: string; note?: string }
}

export type ShareFailureReason =
  | 'not_activated' | 'unknown_channel'
  | 'consent_required' | 'consent_revoked' | 'share_consent_off'
  | 'token_invalid' | 'token_expired' | 'adapter_error'

export type ShareResult =
  | { delivered: true; adapter_id: ShareChannel; sent_at: string }
  | { delivered: false; reason: ShareFailureReason }

export interface ShareAdapter {
  readonly id: ShareChannel
  send(payload: SharePayload): Promise<ShareResult>
}
```

`ADAPTERS` is `Object.freeze`-frozen at runtime (compile-time `Readonly` alone cannot uphold the frozen-record claim) — `{ imessage, sms, slack, webhook } → ShareAdapter`. `SHARE_CHANNELS` derives from `Object.keys(ADAPTERS)` so the closed set has one source of truth. Adding a channel = adding a `ShareChannel` member + adding an `ADAPTERS` entry + (in M4) replacing the no-op stub with a real implementation. The closed-set discipline prevents stringly-typed channel drift.

## 2. Three hard rules (inherited from artifact entries)

1. **Explicit payload shape only.** `SharePayload.body` carries paths, never raw HTML. The HTML / manifest / qr files themselves are the slice 3a outputs and live under their own O_CREAT|O_EXCL discipline; share only references them. This keeps every shared artifact independently auditable via `gotry_artifacts_list` + `gotry_artifacts_read`.
2. **Token gate precedes adapter call.** `shareDeck` always runs `verifyShareToken` first and refuses to dispatch to any adapter when verification fails. No adapter ever sees an unsigned / tampered / expired payload.
3. **Adapters never throw.** `adapter.send(payload): Promise<ShareResult>` returns a `ShareResult` even on delivery failure. `shareDeck` never lets an adapter exception escape; the contract surface is the `ShareResult` union.

## 3. Share token (HMAC-SHA256, base64url)

Token shape: `<body>.<sig>` where `body = base64url(JSON.stringify(payload))` and `sig = base64url(HMAC-SHA256(body, secret))`.

- `payload` = `{ share_id, created_at (ISO), ttl_seconds, target: { channel, address } }` — the destination is inside the signature; a validly-signed token replayed to a different recipient fails `tokenTargetMatches` → `token_invalid`
- `secret` defaults to `SHARE_HMAC_SECRET` env, falling back to `DEFAULT_DEV_SHARE_SECRET` (`gotry-share-dev-secret-DO-NOT-USE-IN-PROD`) so dev / test never have to set env. **`resolveShareSecret` throws when `NODE_ENV=production` and the env var is missing** (fail-closed) — a forgotten env never signs production tokens with a constant committed to the public repo.
- `verifyShareToken(token, secret, now)`:
  - format check (**exactly one dot**, `indexOf === lastIndexOf`; the base64url decoder silently skips invalid chars, so multi-dot tokens must be rejected explicitly) → `token_invalid`
  - HMAC `timingSafeEqual` check → `token_invalid` on any mismatch (body or sig)
  - payload shape validation (share_id / created_at / ttl_seconds types) → `token_invalid`
  - ttl validation: non-negative integer capped at `2^31-1` seconds (prevents `expiresMs` overflow to `Infinity`) → `token_invalid`
  - expiry: `now > created_at + ttl_seconds * 1000` → `token_expired` (ttl = 0 expires at the next instant)
  - on success returns `{ ok: true, payload }` for the caller to feed into `checkShareConsent`
- `signShareToken` is byte-level deterministic for fixed `(payload, secret)` — verifiable by `sha256(token)`.

## 4. Share consent state machine

- `mode: 'ask' | 'allow' | 'off'` — total switch. `off` rejects everything with `share_consent_off`. `ask` and `allow` both require a granted card per share_id; `allow` is "user pre-authorized at install time" (no per-share dialog needed), `ask` is "prompt every time". Both modes share the `consent_required` reason when no card is present (so UI can render a single prompt path).
- `granted: ShareConsentCard[]` — append-only history of cards (`card_id: UUID`, `share_id`, `granted_at: ISO`). `grantShareConsent` is idempotent per share (reuses the existing live card instead of appending) so duplicate grants cannot drift the card set or break revocation totality.
- `revoked: string[]` — list of revoked `card_id`s. `revoke` is idempotent.
- `checkShareConsent(state, share_id, card_id?)`:
  - `mode === 'off'` → `share_consent_off`
  - no granted cards for `share_id` → `consent_required` ("never granted" — distinct from revoked)
  - has granted cards but all are in `revoked` → `consent_revoked` ("was granted, then taken back" — distinct from required)
  - caller-provided `card_id` must itself be a live card for that share (matched by id across all cards, not just the first live one) → `consent_revoked` (forgery guard)
- All transitions are pure: `grantShareConsent` / `revokeShareConsent` / `setShareConsentMode` return new state objects, never mutate.

## 5. shareDeck flow

```
1. verifyShareToken(token, secret, now) → if !ok: return reason
2. checkShareConsent(state, share_id) → if !ok: return reason
3. ADAPTERS[payload.target.channel] → undefined → 'unknown_channel'
4. adapter.send(payload) → return result.delivered ? {...result, sent_at: result.sent_at ?? now()} : result
```

The function never throws. Every `ShareFailureReason` is a reachable return path and is exercised by the test suite (§5c explicitly enumerates all eight and asserts each is fired by an actual scenario).

## 6. Decision log

- **Why HMAC and not asymmetric signing.** The token is internal-share — produced and consumed within the gotry runtime. Asymmetric signing would add a key-management surface for no adversary model benefit here. HMAC-SHA256 with a single shared secret + `timingSafeEqual` on verify is the right power level. Future M4+ slices that produce share tokens for *external* consumers (e.g., a hosted share URL) can layer asymmetric signing on top; for now, internal-only HMAC.
- **Why `consent_required` and `consent_revoked` are distinct reasons.** UI/audit needs to distinguish "user never authorized this share" (prompt) from "user authorized then revoked" (no retry without explicit re-consent). Conflating them would let an adversary retry after a revocation succeeds.
- **Why no SDK calls in Phase C.** A real iMessage / SMS / Slack / webhook integration involves credentials, rate limits, and provider-side state. Doing that work in a slice whose stated non-goals are "do not activate runtime" would conflate two distinct risk surfaces. Phase C delivers the contract + stub + flow; M4 replaces the stubs. Until then, every adapter call returns `not_activated`, which is itself a valid `ShareResult`.
- **Why `ttl_seconds` is in the token payload, not a separate field.** Embedding it in the signed payload means a tampered ttl is detected by HMAC verification, not by a separate validation step. One source of truth, one verification path.
- **Why `payload.body` carries paths only.** The HTML / manifest / qr artifacts are owned by the slice 3a bundle; share references them by path so that `gotry_artifacts_list` / `gotry_artifacts_read` remain the canonical audit surface and share never duplicates or copies content. If share were to embed HTML inline, audit would have to look in two places.
- **Why `mode: 'allow'` doesn't bypass the card requirement.** A user pre-authorizing "yes, share generally" at install time should still bind each share to a specific grant (so revocation works). The `allow` distinction is *which UI surface* prompts the user (none vs a one-time card), not whether the per-share card exists.

## 7. Slice status and explicit non-claims

Landed here: `ts/src/share/{adapters,share-token,share-consent,share-deck}.ts` + `ts/scripts/share-tests.ts` (73 assertions after the self-review hardening pass, run-all §6h). All four adapter stubs are no-op by design. Token signing is byte-deterministic. The eight `ShareFailureReason` values are all reachable by real scenarios and the suite proves it.

Not in this slice: real SDK calls for any of the four channels (M4); `gotry_share_*` dsh tool registration (M4); trigger-driven share events from the wish-pool or external-event seam (M4 / Phase D); a hosted share URL service (research E.2). The seam is contract-complete; the M4 work plugs adapters and wires the dsh surface without touching this module's API.

## 8. Cross-references

- `docs/research/karpo-deck-web-research.md` §3 Phase C — the slicing decision and what this slice owes.
- `docs/design/itinerary-deck-renderer.md` — the renderer whose products the share references by path.
- `docs/code-map.md` rows for `ts/src/share/*` — the module inventory line for this slice.
- `ts/capabilities/session-consent.ts` — the consent-pattern reference (parallel, not merged).
