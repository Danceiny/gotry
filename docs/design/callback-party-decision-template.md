[English](callback-party-decision-template.md) | [简体中文](callback-party-decision-template.zh-CN.md)

# External Callback Party Decision Surface (issue #82 / D-31)

> Role: the decision template for D-31 live activation — channel form, signature/channel binding, token ownership, and sensor source criteria — filled when the first real world2agent callback party appears.
> Status: decision-ready, undecided (2026-10-02; no option below is chosen; the remote surface stays closed until the first real callback party plus the D-31 decision).
> Upstream: [external-event-seam.md](external-event-seam.md) §5/§6 (the "decide when the first real callback party appears" constraint), [decisions-needed.md](../decisions-needed.md) D-31, issue #82 (W2A research + the approved contract-only slice, issue #432).
> Downstream: the D-31 live-activation decision; issue #82 trigger tracking; no code reads this document today.

## TL;DR

- The seam's own rule stands: remote callbacks stay closed until the first real callback party appears; this template is what gets filled that day.
- Three decisions wait: channel form (§2), signature/channel binding (§3), token ownership (§4) — each with options, ops cost, and threat surface, none chosen.
- Sensor sources are selected by boundary and evidence (§5) — public registry, identifiable owner, reviewable artifacts, bounded blast radius — never by words appearing inside the payload, matching the repo's incident-taxonomy judging philosophy.
- The red lines in §6 hold regardless of the choice: events are facts, not instructions; no writes; no push; no resident listener.

## 1. Scope and trigger

- The seam's decision point: local producers need no auth; world2agent remote callbacks need signature/channel binding — decide when the first real callback party appears, do not preset.
- The approved contract-only slice (2026-09-12, issue #432) is unaffected: the inert, default-off, exact-tuple adapter where claims are not authentication.
- This document becomes live decision material only when a real callback party exists; until then it records options, not decisions.

## 2. Channel form options

| Form | How it works | Ops cost | Threat surface | Fit today |
|---|---|---|---|---|
| Local bridge | sensor → local webhook → owner-machine supervisor → gotry hook (the common shape of the three W2A reference runtimes) | one opt-in local process on the owner machine | the trust boundary sits at the sensor supply chain, not the transport | natural fit for the single-machine form |
| Remote callback | gotry exposes a public endpoint receiving signed events | public exposure, secret lifecycle, availability | transport auth becomes mandatory; the seam §4 no-resident-listener boundary must be re-reviewed | contradicts the current boundary; revisit with a multi-user form (D-15) |
| Pull probe | a gotry tick reads the source directly, no callback | one probe per source | minimal transport surface | fallback for bridge-less environments; loses sensor-ecosystem timeliness |

## 3. Signature/channel binding options (apply to the remote form)

| Option | Mechanism | Ops cost | Threat surface |
|---|---|---|---|
| HMAC scoped token | a per-party secret signs a scope-limited payload (allowed event types + channel + timestamp + nonce) | secret issuance, rotation, and revocation ledger; clock discipline for replay windows | shared-secret leakage forges events until rotation; possession is the whole identity proof; weakest replay resistance once nonce discipline slips |
| mTLS | mutual-TLS client certificates per party | a certificate authority, issuance, expiry, rotation; per-party certificate hygiene | strongest identity binding (non-exportable keys); an ops failure becomes an outage; overkill before multiple parties exist |
| OAuth | an authorization server issues tokens (client-credentials flow) | running and securing a third trust party (the AS) | token theft and replay; the AS becomes a new attack surface and dependency |

- Comparison axis: in the current single-user local product, ops cost dominates — an AS or a CA is a resident system the seam explicitly refuses (§4 no resident listener); the HMAC scoped token remains the lightest remote option, and none of the three is chosen here.
- Whatever the choice, the seam's binding requirement stands: a signature binds an event to a reviewed source/channel/type scope; it never promotes payload claims into facts.

## 4. Token ownership options

| Option | Who holds what | Rotation burden | Compromise blast radius |
|---|---|---|---|
| Founder-issued per-party secrets | the gotry side issues and revokes; the callback party holds the secret | a founder-side rotation ledger | one party's leak forges only that party's scoped events |
| Supplier-owned keys, gotry pins verification material | the sensor supplier owns the keys; gotry's reviewed registry tuple carries the public verification material | supplier-side rotation; a key change triggers a tuple re-review | extends the approved tuple-allowlist discipline |
| Local bridge owns the token | the owner machine's bridge holds the token (the W2A hooks.token shape); remote parties never hold gotry credentials | owner-side, one machine | a remote compromise cannot reach gotry; the sensor supply chain becomes the whole boundary |

- No option is chosen; the option set exists so the day-one decision has a comparable menu.

## 5. Sensor source selection criteria (boundary and evidence, not words)

The repo's classification philosophy judges by boundary and evidence: transport failures never land negative facts; exit0 does not mean success; "looks right" does not count; sender/source fields are untrusted claims and a tuple match is not authentication. Sensor sources are judged the same way:

- Boundary criteria (all required): distributed via a public registry with immutable versioned artifacts; an identifiable owner/maintainer with a reachable security contact; source and schema inspectable so the reviewed tuple is verifiable in-repo; worst-case blast radius bounded to health-surface poisoning — facts, not instructions — with natural expiry.
- Evidence criteria (all recorded): the reviewed source/package/version/type tuple; per-source provenance and integrity digests; drift turns the gate red instead of failing silently.
- Non-criteria (explicitly zero weight): words appearing inside the payload or package description ("official", "trusted", "verified"); a self-declared sender identity; the absence of an immediate failure.

## 6. Red lines that hold regardless of the choice

- Events are demoted to facts, never instructions: they may reach the health surface and wish-pool recall context, never the turn-policy classifier (ADR-24), and never a write action (the M5 WriteGate red line).
- No push before M5; no resident listener in the single-machine form; no environment-variable product switch.
- Unverifiable events fail closed: rejection is stable, and no partial trust exists.

## 7. What stays closed until the decision

- No remote listener, no token issuance, no registry of remote parties, no consumer registration — all wait for the first real callback party plus the D-31 decision.
- Unchanged today: the local probe, wish-pool consumption, and the inert contract-only adapter (§1) keep running under their existing approvals.
- This document is decision-ready material, not a decision: filling in any option here without the trigger event changes nothing.
