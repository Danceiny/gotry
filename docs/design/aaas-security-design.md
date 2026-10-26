[English](aaas-security-design.md) | [简体中文](aaas-security-design.zh-CN.md)

# AaaS Security Design: Threat Model (Draft)

> Role: the threat model of the multi-user GoTry service — assets, actors, trust boundaries, threats, and the control and proving phase for each threat.
> Status: proposal (A0 of [#674](https://github.com/Danceiny/gotry/issues/674), drafted 2026-10-26). It becomes living once the [AaaS RFC](../rfc/aaas-rfc.md) is accepted.
> Upstream: [AaaS RFC](../rfc/aaas-rfc.md); [architecture](../architecture.md) §1.3 invariants and ADR-23; hotel-be deployment constraints C2, C6, C10, C13, C14, C15 and C16.
> Downstream: the A2 adversarial suite, the A3 boundary ADR and failure drills, and the maintainers of the [security policy](../ops/security.md).
> Evidence boundary: this draft is analysis, not proof. A threat counts as mitigated only when its falsification test exists and passes. Drills and fixtures prove engineering behavior only.

## TL;DR

- The highest-impact threats are cross-tenant access (S-1 to S-4), cross-organization bridge routing onto another organization's supplier login (S-5), stale-owner writes (S-6), and bearer keys once traffic leaves loopback (S-7, S-8).
- Two invariants carry most of the weight: the tenant is derived only at the trusted seam, and every durable write is fenced by epoch.
- Today's per-node form is protected mainly by the loopback boundary (C2, C16) and ADR-23 request bindings. AaaS removes the loopback premise, so A2 and A3 must replace it.
- Supplier login state stays out of the cloud. AaaS adds no server-side session store.
- Denial of service is mostly about cost: LLM budget, planner workers, bridge long polls, and the organization's shared supplier login.

## 1. Scope and assets

| Asset | Where it lives | Why it matters |
|---|---|---|
| Tenant ledger | Motivation, wish pool, companions, timeline, Booking Copilot tasks, work orders | Personal data; companion constraints may include health and diet |
| Tenant working files | The planner working directory, handoff tickets, deliverables, artifacts | Same sensitivity as the ledger |
| Organization bridge lane | `bridge.db` and the extension long poll | Routes jobs onto a real supplier login held in an employee browser |
| Service credentials | One BFF bearer key per surface (C13); LLM provider keys | Impersonation and spend |
| Budgets | LLM tokens, planner workers, supplier pacing | Cost and the organization's standing with suppliers |
| Off-node copies | Replicated tenant files and snapshots | Deleted data could survive here |

## 2. Actors and trust boundaries

| Actor | Trust | Notes |
|---|---|---|
| End user (tenant) | Authenticated by the organization's BFF | May be curious about, or hostile to, other tenants |
| Organization BFF | Trusted to authenticate users and assert the principal | With per-organization credentials, a compromised BFF can impersonate only its own organization's users |
| Browser extension | An untrusted transport inside an employee browser | Holds the supplier login; authenticated by organization-scoped join tickets that hotel-be issues (C16) |
| Replica operator | Trusted with host access | Access is audited; off-node copies are encrypted |
| Content sources | Untrusted | Supplier pages, web results and model output are data, never instructions |
| Intranet peer | Untrusted | Relevant once the tier leaves loopback (A3) |

The trust boundaries are: browser to BFF (hotel-be is the authority); BFF to the gotry tier (loopback today, intranet at A3); replica to the lease store and the object store; and tenant to tenant inside one replica.

## 3. Threats

| ID | Threat | Today | Proposed control | Proving phase and falsification test |
|---|---|---|---|---|
| S-1 | A request supplies or alters a tenant id to read another tenant's state | Server paths share tenant `local`; ADR-23 binds principal and scope digests | Seam-only derivation (`HMAC(K_org, issuer ‖ subject)`); no API accepts a tenant id | A2: forged tenant fields in the body, headers, tool arguments and model output are ignored or rejected |
| S-2 | Shared state leaks across tenants through a shared ledger, cache, planner session or working directory | One `local` ledger per node | One ledger and one working directory per tenant; planner sessions and caches keyed by tenant | A2: two tenants with colliding task handles, request keys and wish names each read only their own rows |
| S-3 | An id becomes a path and escapes its directory | Ids are validated per surface | Tenant ids are fixed-format hex digests; paths are built only from them | A2: path-shaped and oversized ids are rejected before any filesystem call |
| S-4 | Tenant B replays a handle of tenant A (`taskHandle`, `requestKey`, artifact id) | Handles are bound to principal and scope digests | Handles resolve only inside the caller's tenant ledger | A2: a foreign handle returns not-found, never another tenant's data |
| S-5 | A bridge job of organization A runs on organization B's extension with B's supplier login, or B's result reaches A | No organization column; matching by site, origin and client id | An organization-scoped bridge ledger and owner; matching requires organization equality; organization-scoped join tickets | A2: cross-organization claims and result posts are rejected and leave no row |
| S-6 | A stale owner keeps writing after a partition or a pause | One node, so not applicable | A lease with an epoch; epoch-scoped durable copies; a self-fencing margin | A1: a paused owner's writes after takeover never appear in the restored ledger |
| S-7 | A bearer key is sniffed or leaked once traffic leaves loopback | Loopback only (C2); one key per surface (C13) | Per-organization credentials with mTLS or signed short-lived assertions; key rotation | A3: the boundary ADR's tests reject unauthenticated and cross-organization calls |
| S-8 | Anyone holding the BFF key can assert any principal | Accepted while only the local BFF holds the key | Assertions signed per organization and bound to the request digest; principal digests audited | A3: an assertion for organization B signed with A's key is rejected |
| S-9 | Supplier login state moves into the cloud | Red line: cookie values never cross the bridge protocol (extension tests §38) | AaaS adds no server-side session store; no schema carries a cookie value | A2: a schema scan finds no cookie-value field |
| S-10 | One tenant exhausts the LLM budget, planner workers, long-poll slots or ledger size | Request body limits; per-turn deadlines | Per-tenant and per-organization quotas; a global worker cap; typed 429 | A2: a flood from one tenant keeps another tenant's latency within budget |
| S-11 | One tenant gets the organization's shared supplier login rate-limited or banned | Pacing per node and per site | Pacing per organization and per site, with per-tenant shares | A2: a burst from one tenant is throttled before it reaches the site |
| S-12 | Deleted data survives in off-node copies | No off-node copies exist yet | Per-tenant data keys; forget destroys the key | A1: after forget, restoring any copy yields no readable tenant data |
| S-13 | An operator reads tenant files | A dedicated service user and `umask 0077` (C6, C14) | Encrypted off-node copies; audited access | A3: the drill shows copies are unreadable without the tenant key |
| S-14 | Prompt-injected content triggers cross-tenant reads or write actions | Observations are data; writes are sealed | Tools carry no tenant parameter; WriteGate unchanged | A2: injected instructions that name another tenant produce no cross-tenant read |
| S-15 | A captured BFF request is replayed | Request keys are idempotent | Request keys scoped by tenant; assertion expiry | A2: a replay returns the original result and creates no new effect |
| S-16 | A mixed-version fleet enables a feature some replicas lack | Feature intersection rule (ADR-23) | Ownership moves only between compatible replicas | A3: a rolling-deploy drill keeps optional features off until every replica advertises them |

## 4. Security invariants

1. The tenant is derived at the trusted seam, from the authenticated principal, and nowhere else.
2. Every durable write carries its writer's epoch; a lower epoch never becomes authoritative.
3. A tenant's ledger, files, caches and planner sessions are reachable only through that tenant's handle.
4. Bridge jobs and results never cross an organization.
5. No supplier credential value exists on the server.
6. Forget removes a tenant from every copy, including off-node ones.
7. The gotry tier is never browser-reachable (C16).

## 5. Rejected options

| Option | Why it is rejected |
|---|---|
| Let the browser or the extension call the gotry tier directly | It puts the server key in the browser and makes gotry browser-reachable (C16) |
| Accept a tenant id from the BFF payload | Any payload bug becomes cross-tenant access; the seam derives the tenant instead |
| Rely on a Redis or database lock without fencing | A lost or duplicated lock would let two writers commit |
| Store supplier cookies on the server to share logins | It violates the 2026-09-11 decision and turns the service into a login farm |
| Forget by deletion alone, without key destruction | Copies and snapshots would keep the data |

## 6. Open questions

- Which signed-assertion format the BFF can issue, and who rotates its keys (A3 boundary ADR).
- Whether hotelbyte's object store supports server-side encryption with customer-managed keys (RFC fact F-3).
- How long off-node copies are retained before crypto-shredding becomes the only delete path (RFC Q5).
