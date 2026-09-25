# Session Link and Plan-It Action (issue #580)

> 状态: **契约层已落地(Phase E 切片 1)**。消费端(scheme handler / dsh Web UI 路由)
> 注册是 M4 激活;本文件界定链接词位、载荷 schema 与失败语义。
> 双语对:`session-link.zh-CN.md`(分歧即 bug,i18n checker 把关)。

## TL;DR

A session link is a signed, expiring, **schema-closed** token that names an
opaque local session reference plus a closed-set action (`plan_it` | `open`).
It is the one-tap closure of the why-now card (issue #577, Phase D): "好,规划它"
deep-links back into the local session to keep planning a wish — **it opens, it
never writes**. The write-gate seal is expressed structurally at the link layer:
book/pay/confirm do not exist in the action vocabulary, so a write-action link
cannot even be constructed (sign throws), let alone verified.

- Token: `body.sig` — base64url(JSON payload) + base64url(HMAC-SHA256).
- Payload: exactly six keys (`link_id` / `session_ref` / `action` / `wish_id?` /
  `created_at` / `ttl_seconds`); unknown keys are rejected at verify time —
  *de-identified by construction* made testable: a link carries references,
  never facts or memory.
- `plan_it` ⇔ non-empty `wish_id` (paired both directions); `open` must not
  carry `wish_id`.
- `session_ref` is an opaque reference, never a path: `/` `\` `..` NUL and
  >128 chars are refused at sign **and** verify — the link-layer form of
  "never write shared state": a link can never name a state path.
- Failures: a 2-class closed set (`link_invalid` | `link_expired`); verify
  never throws — a missing production secret, a non-string runtime secret key
  (number/object/Symbol), and an invalid injected clock (non-finite time or a
  throwing callback) are operational errors that fold into `link_invalid`;
  consumers fail closed (an invalid link opens nothing).
- URL form is render-time only (`formatSessionLink(token, base?)`, default
  `gotry://session/<token>`; a local HTTP consumer may pass
  `http://127.0.0.1:3080/session`); the signed bytes never embed a host.

## 1. Why a separate token from the share token (Phase C)

The share token (issue #573) and the session link share the HMAC hardening
checklist — exactly one dot, timingSafeEqual (length first), integer ttl capped
at 2^31-1, injected clock (a non-finite or throwing clock is itself invalid at
verify), production fail-closed secret (`SESSION_LINK_HMAC_SECRET` — the
deliberate throw lives on the issuance side; verify folds the same
configuration error, a non-string runtime key, and any HMAC computation
failure into `link_invalid`). They deliberately do **not** share
a verifier:

| dimension | share token (Phase C) | session link (Phase E) |
|---|---|---|
| payload schema | required fields + extension allowed (manifest grows) | **closed**: unknown keys → invalid (de-identified by construction) |
| action vocabulary | n/a (delivery target, not an action) | `plan_it`/`open` only; write verbs unconstructable |
| failure set | 8 classes incl. adapter/consent | 2 classes (no channel/consent dimension) |
| threat model | replay to a different recipient | injection of facts/state paths into the session host |

Two independent secret surfaces: the dev fallbacks are distinct constants, and
production requires its own env var for each.

## 2. Action vocabulary = the WriteGate seal

`SESSION_LINK_ACTIONS` is a two-word closed set. The seal is structural, not
procedural:

- signing an action outside the set throws at construction;
- even a hand-forged valid-HMAC token carrying an unknown action is
  `link_invalid` at verify;
- there is no `book`/`pay`/`confirm` word slot to smuggle in, and adding one is
  a contract change requiring review.

`plan_it` means *resume planning this wish in the local session*. Booking and
payment remain impossible through this surface by construction, not by policy
comment. (The product-level WriteGate seal is untouched; this layer adds no
write path.)

## 3. Payload contract and guards

| field | rule |
|---|---|
| `link_id` | non-empty string, caller-supplied idempotency id |
| `session_ref` | opaque, 1..128 chars, no `/` `\` `..` NUL |
| `action` | `plan_it` \| `open` (closed set) |
| `wish_id` | `plan_it`: required, non-empty string; `open`: must be absent |
| `created_at` | parseable date string |
| `ttl_seconds` | integer in `[0, 2^31-1]` |

Guards run at **both** layers: sign throws (bad links never leave the factory),
verify rejects anything that bypassed sign (hand-forged HMAC still dies on
shape). Expiry compares the injected clock against
`created_at + ttl_seconds * 1000`; `ttl_seconds = 0` is a valid
single-moment link. A clock that is non-finite or throws is itself
`link_invalid` — acceptance is never granted on an invalid time (`NaN`
compares false against every bound, which once let an expired link through).

## 4. URL rendering and parsing

`formatSessionLink(token, base?)` joins `${base}/${token}`; the default base is
`gotry://session`. The scheme/host choice belongs to the consumer at render
time — the signed payload carries no host detail, so one token family serves
the OS scheme handler and the local web UI alike.

`parseSessionLink(url)` is strict: it takes the last path segment, requires it
to look like `body.sig` (so a bare base such as `gotry://session` is not
mistaken for a token), and refuses any URL with a query or fragment — a
concatenation ambiguity (`?x=../../etc`) is a fail-closed null, never a
best-effort extraction. Parse output is always fed to `verifySessionLink`,
which is the final authority.

## 5. Plan-it action card

`buildPlanItAction(card: WhyNowCard, deps)` produces data, not HTML:

```ts
interface PlanItAction {
  kind: 'plan_it'            // constant by construction
  label: string              // closed vocabulary 「好,规划它」
  deep_link: string          // formatSessionLink(default base)
  wish_id: string            // same value as the token payload — same-source
}
```

`wish_id` enters the payload from the card's structured field (WhyNowCard
gained `wish_id` in this slice — a Phase D contract completion: a one-tap
action must name its target structurally, not by parsing the title string).
Display surface and opened session cannot drift apart because they are the
same value at construction. A card without a non-empty `wish_id`, or a
path-like `session_ref`, throws — the action layer is fail-closed and never
emits a link that opens nothing.

`not_now` is a render-surface local dismissal: no link, no state write. It is
deliberately outside this contract.

## 6. Decision log

1. **Schema-closed verify (unknown keys rejected)** — the de-identified
   promise made testable; differs from the share token on purpose (different
   threat models).
2. **Action vocabulary as the WriteGate seal** — structural exclusion beats
   procedural checks; a word slot that does not exist cannot be exploited.
3. **`plan_it` ⇔ `wish_id` paired both ways** — prevents a plan link with no
   target and an open link smuggling a targeted intent.
4. **`session_ref` path guards at both layers** — "the link can never name a
   state path", the link-layer form of the no-shared-state rule.
5. **Token stays out of the URL until render time** — consumers choose scheme
   and host; local HTTP and OS scheme handler share one token family.
6. **`parseSessionLink` refuses query/hash** — concatenation ambiguity is
   fail-closed, not best-effort.
7. **WhyNowCard gains `wish_id`** — Phase D omission surfaced by the one-tap
   requirement; structural self-reference, not title-string reverse parsing.
8. **Fix in passing: recall module publish gap** — `ts/src/recall/*.ts` were
   missing from the root package `files[]` (PR #578 publish-manifest gap,
   same class as the QR gap fixed in #576); added alongside the session-link
   entries.

## 7. Slice status and explicit non-claims

Landed (this slice):

- `ts/src/session-link/session-link.ts` — sign/verify/format/parse + guards
  (verification-time secret resolution and clock reads are guarded; issuance
  keeps its deliberate configuration throws).
- `ts/src/session-link/plan-it-action.ts` — the one-tap action card.
- `ts/scripts/session-link-tests.ts` — 96 assertions, all offline (production
  without a secret is exercised in an isolated subprocess environment).
- WhyNowCard `wish_id`; registration in `scripts/run-all-tests.sh` §6j.

Explicit non-claims:

- **No scheme handler / dsh route registration** (M4 activation; a consumer
  that cannot verify must open nothing).
- **No hosted sharing service** — the separate founder decision (research doc
  open decision #1); static-first remains the recommendation.
- **No outbound delivery** — why-now card → notification transport is the M4
  wiring of the share/recall contracts.
- **No write path of any kind** — the vocabulary seal plus the unchanged
  WriteGate keep booking/payment impossible from this surface.
- **No kernel changes.**

## 8. Cross-references

- Research: `docs/research/karpo-deck-web-research.md` §3 Phase E row.
- Why-now card producer: `docs/design/recall-trigger.md` (issue #577).
- Share token (the other HMAC surface): `docs/design/share-adapters.md`
  (issue #573).
- Seam authority: `docs/design/external-event-seam.md` §3.3/§4 (pull model;
  M5 before push).
- Milestones: `docs/roadmap.md` (M4 owns activation).
