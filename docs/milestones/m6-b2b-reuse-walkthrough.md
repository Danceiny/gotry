[English](m6-b2b-reuse-walkthrough.md) | [简体中文](m6-b2b-reuse-walkthrough.zh-CN.md)

# M6 B2B reuse walkthrough memo (P6, awaiting founder review)

> Status: draft (2026-09-08, issues #137/#225; **P6 Exit holds only when the founder explicitly says `YES approve the overall plan` or explicitly approves a revised draft**; NO / proposed changes keep it TODO — do not freeze it on your own. P6 approval is not M6 Entry; M5 Exit remains a hard prerequisite)
> Acceptance criteria (master outline §4 P6 row): pick 1-2 B2B forms and walk through the two-layers-of-why wrapping and the reuse boundary; red lines carried through; measured numbers must come from real loading proof after M6 Entry.
> Inputs: [`../gotry-master-outline.md`](../gotry-master-outline.md) §3.7, [`../research/enterprise-travel-reference-study.md`](../research/enterprise-travel-reference-study.md), [`../architecture.md`](../architecture.md) ADR-16/23, issues #137/#225/#229/#236/#237/#241/#242/#227.

## 0. Conclusions first

1. **Still two B2B forms**: travel-agency embedding (primary, matching the M6 engineering proof and pilot form) + destination tourism board (secondary, verifying the sponsor configuration surface is not agency-hardcoded).
2. **"principal" must be term-separated**: M6's traveler principal is the subject of "why the trip departs"; ADR-23's BFF/HTTP principal is a security identity. The two must not reuse a type name or semantics.
3. **The three change-surface plugin slots are only hypotheses awaiting PoC**: entry, inventory pool, sponsor configuration/disclosure. The existing MotivationProfile + hard constraints and the `motivation_save` evidence guard support only the hypothesis that "downstream reuse may hold"; there is not yet a sponsor type, configuration, inventory-pool interface, disclosure slot, or B2B E2E.
4. **The reuse proof is no longer written as a slogan**: M6 can only report zero diff on the fixed frozen `kernel-set`, runtime actual-loading coverage, pre-declared functional-path coverage, and an auxiliary loaded LOC ratio. `kernel-set` must not be shrunk to the modules some run happened to load; these engineering metrics do not represent traveler satisfaction or sponsor conversion.
5. **The tenant/CLI isolation base is already in main**: tenant ledger scope (#229) + fold (#237), state-cli (#236/#241/#243), and the Z3/map stability fixes are all merged; #227/#241/#242 are closed. The M6 sponsor plugin proof must still cite actual run evidence at its own final SHA, but these closed issues add no new M6 Entry conditions.
6. **The disclosure plugin stays a proposal**: sponsor revenue disclosure is preferably injected as rendered fragments by the sponsor plugin; if M5 demands a schema reservation first, the kernel must keep zero dependency on sponsor semantics.
7. **Commercial pilots are not signed on engineering's behalf**: P6 founder approval and real pilot signing/commercial terms are business/legal dependencies; the engineering proof cannot substitute. The unsigned status only explains why the whole thing remains TODO; it cannot satisfy M6 Exit.

## 1. principal term separation: three subjects, three boundaries

| Subject | Layer | Semantics | Why it must not be conflated |
|---|---|---|---|
| traveler principal | M6 / product motivation layer | The traveler; the audience the motivation interview reaches; the subject of MotivationProfile | Sponsor revenue goals must not be written into traveler motivation |
| sponsor | M6 / commercial and inventory layer | Partners: travel agency/TMC/hotel/airline/destination tourism board etc. | A sponsor may configure entry/inventory/disclosure but cannot override traveler constraints |
| BFF principal / `BookingIngressPrincipal` | ADR-23 / embedded Booking Copilot security surface | Authenticated HTTP/BFF actor, scope, and request binding | It proves "who may call the API", not "who departs and why" |

Naming recommendation: the M6 namespace uses `sponsor.*` and `traveler.*`; do not reuse the `booking.surface` principal types to carry motivation semantics. The BFF principal only enters authentication and request binding; only the traveler principal enters the motivation profile, memory, and itinerary explanation.

## 2. Walking the two layers of why

**B2C (current state)**: traveler principal = sponsor = the users themselves. The motivation interview (material → aspiration → hard constraints → candidate set; destinations inside the material are only soft preferences) goes straight to `gotry_motivation_save`, which persists the MotivationProfile; the whole downstream chain consumes it.

**B2B travel-agency embedding (primary form)**:

- traveler principal = the traveler; sponsor = the travel agency. The agency may relay the customer's intent, but the persisted weight delta must still carry traveler verbatim words or auditable evidence; "the agency wants to sell a route" is not traveler evidence.
- The sponsor layer wraps only entry, inventory pool, and disclosure rules: packaged routes/departure dates/contract prices, branded entry, customer-service contact, commission disclosure. It does not write MotivationProfile.
- Journey walkthrough: agency H5/mini-program/BFF entry → traveler motivation interview → `motivation_save` → feasibility/itinerary/transparency cards → sponsor inventory candidates and revenue disclosure → M5 WriteGate (if a write path occurs).
- Sponsor revenue may influence the disclosure dimension of candidate ranking; it must not become a reason to hard-filter traveler motivation; any ranking bias must be shown to the traveler.

**Sponsor rights-and-duties table (awaiting PoC/agreement validation):**

| Duty | sponsor may | sponsor may not | Evidence/receipt ownership |
|---|---|---|---|
| Motivation input | Provide entry context or relay customer requests | Write commercial preferences in as traveler motivation evidence | Traveler verbatim words or an auditable authorization source |
| Authorization source | Declare partner inventory, after-sales, and quote sources | Confirm personal constraints or travel motivation in the traveler's place | BFF/business authorization kept separate from traveler evidence |
| External-write confirmation | Provide supplier fields and after-sales path per the M5 WriteGate | Bypass the receipt or silently order in the traveler's place | `ApprovalReceipt` bound to traveler/tenant/request fingerprint |
| receipt issuance | Provide supplier receipts, cancel/refund status | Treat "request sent" as success | supplier outcome + order-query/manual reconciliation evidence |
| Disclosure duty | Disclose commissions, sponsorship, ranking bias, customer-service SLA | Hide high commissions or partner material sources | disclosure digest enters the request fingerprint |
| Compensation duty | Provide cancel/refund/after-sales flows and SLA | Book a local cancel as a completed refund | cancel/refund/wallet outcomes projected separately |

**B2B destination tourism board (secondary form)**:

- sponsor = the destination tourism board; inventory pool = local POIs/activities/ticketing/seasonal themes.
- Partner material needs source attribution and sponsorship disclosure, but the material is still only an aspiration expression, not a destination hard directive.
- The secondary form exists to falsify "agency-specific design": if the three plugin slots (entry, inventory pool, disclosure configuration) cannot cover the tourism-board scenario, the reuse-boundary table needs rework.

## 3. Reuse boundary list (based on origin/main `d1d7b5a`)

**Kernel reuse surface (must be byte-identical at M6 proof time):**

| Kernel component | Location/file set | B2B consumption |
|---|---|---|
| MotivationProfile + hard constraints | `ts/src/model.ts`; `ts/src/memory-capture.ts`; the motivation projections in `ts/src/state-ledger.ts` | As-is; weight semantics belong to the traveler and do not vary by sponsor |
| Solving and true cost | `ts/src/unified.ts`; `ts/src/model.ts`; the shared Z3 layer | As-is; candidates come from the sponsor inventory pool; solving is sponsor-unaware |
| Fact gate and evidence chain | `ts/src/bookable-facts.ts`; `ts/src/artifact-gate.ts`; fact-log | As-is; B2B bookable/sellable claims get the same exact-date backtracking |
| Memory / wish pool / companions / timeline | `ts/src/memory-*`; `ts/src/wish-pool.ts`; `ts/src/companions.ts`; `ts/src/travel-timeline.ts` | As-is; after tenant/stateRoot isolation, reads/writes are scoped by traveler/tenant |
| turn handoff / async | `ts/src/turn-*`; `ts/scripts/turn-handoff-collect.ts` | As-is; complex planning is still handoff + follow-up delivery |
| M5 WriteGate seam | the files behind ADR-15/17/18; implemented after M5 Entry | As-is; B2B write paths get no receipt exemption |

**Expected change surface (awaiting PoC; the goal is all-new plugins/configuration, kernel untouched):**

| Plugin slot | Travel-agency form | Destination tourism form | Mechanism template |
|---|---|---|---|
| Entry | agency H5/mini-program/BFF binding | destination funnel page | dsh plugin + BFF request binding; only the BFF principal authenticates |
| Inventory pool | packaged routes, departure dates, contract prices, agency inventory | POIs, ticketing, activities, seasonal material | channel-registry / effect-interpreter registry pattern |
| Sponsor configuration/disclosure | brand, commission, sponsorship, after-sales and customer-service SLA | partner material sources, sponsored events, local subsidies | sponsor plugin injects rendered fragments; proposal |

Placement of the reference study's adopted items: compliance close-out can go through model-request decorators or effect policies; a domain skill = the sponsor plugin's toolset + prompt + boundary guards + renderer. Both fit inside the three plugin slots; if a fourth change surface appears, it must return to P6 review.

## 4. "Reuse rate" measurement definition (reportable only after M6 Entry)

Reuse-rate numbers must carry a reproducible definition:

1. **Baseline SHA**: this document's survey baseline is `origin/main@c1f0ca2`; the M6 proof must re-bind to the actual SHA of main at execution time.
2. **Fixed frozen kernel set**: the §3 reuse-surface file list is frozen as `kernel-set.txt` before implementation; at M6 proof, `git diff <baseline> -- $(cat kernel-set.txt)` must be empty. The set exists for the zero-diff assertion and must not be shrunk to what some run actually loaded; if an agency plugin must modify a core file, the zero-kernel-change assumption fails and re-review is mandatory.
3. **Runtime actual-loading coverage**: a real B2B one-shot/headless run produces `loaded-modules.json`, proving which frozen kernel paths that run actually loaded and reused; `kernel-set.txt` must not be rewritten in reverse.
4. **Pre-declared functional-path coverage**: list in advance the fact gate, WriteGate, async, ledger, and other functional paths the scenario must traverse, and prove item by item whether the run actually reached them; paths not reached cannot be counted as reused.
5. **Auxiliary LOC metric**: `kernel_loaded_loc / total_gotry_loaded_loc` may serve as an auxiliary observation, but it cannot replace the two coverage proofs, nor justify shrinking the fixed `kernel-set`.
6. **User outcomes measured separately**: these numbers only prove "engineering did not change the kernel". Traveler motivation satisfaction, NPS, conversion, and sponsor revenue each need separate cohort/pilot evidence.

The engineering half of M6 Exit should read "fixed `kernel-set` diff=0; runtime actual-loading coverage and pre-declared functional-path coverage complete; agency-embedding E2E passing"; the commercial half must be a real signed pilot. The unsigned status only explains TODO; it cannot substitute for signing.

The schema and generator script for the reuse proof are owned by the later `m6-reuse-proof-schema` task (see [`../design/milestone-delivery-plan.md`](../design/milestone-delivery-plan.md) M6-3): freeze `kernel-set.txt`, `loaded-modules.json`, and the runtime trace schema up front, so implementers cannot invent a denominator on the fly.


## 5. Security and adversarial testing

| Adversarial surface | Minimal test | Failure criterion |
|---|---|---|
| tenant isolation (#229/#237) | two tenants write event/wish/pending under the same business id; each read/rebuild sees only its own | tenant A reads or rebuilds tenant B's projection |
| BFF principal replay | a BFF actor reuses an old requestKey/receipt bound to a new traveler | a request fingerprint or scope mismatch still passes |
| sponsor inventory injection | sponsor A inventory enters sponsor B's tenant | channel/sponsor config not filtered by tenant |
| traveler evidence | sponsor copy generates motivation weights | a `motivation_save` without traveler evidence passes |
| revenue disclosure | a high-commission sponsor candidate ranks first | the card does not disclose the bias/commission source |
| wish pool | a sponsor proactively recalls a wish that fails traveler conditions | conditions overridden by a sponsor campaign |

The tenant ledger scope (#229/#237), state-cli tenant and decimal boundaries (#236/#241/#243), and the Z3/map stability base are all in main; #227/#241/#242 are closed. The M6 sponsor plugin proof must still cite actual run evidence for these capabilities at its own final SHA.

## 6. Red lines carried through

- **Traveler motivation first**: the motivation interview reaches the traveler; in B2B, sponsor commercial goals must not rewrite MotivationProfile.
- **Sponsor revenue disclosure**: transparency cards must disclose sponsor revenue/partner sources/ranking bias; disclosure itself does not prove traveler value.
- **WriteGate travels along**: B2B proxied booking/payment is subject to the M5 WriteGate exactly like B2C; L4 automatic classes must also be revocable.
- **Evidence red lines**: `motivation_save` without evidence refuses to persist; wish pool conditions are mandatory; bookable claims must pass the fact gate.
- **Privacy boundary**: BFF principal, traveler principal, and sponsor all use HMAC/ref/digest; public proofs must not commit PII, order numbers, contract text, or raw sessions.

## 7. Dependency on M5 (gate relations)

M6 Entry = M5 Exit + explicit P6 founder approval; both are indispensable. P6 approval may complete first, but it does not open M6 implementation by itself. M6's real dependencies on M5:

1. WriteGate productionized receipt/outbox/unknown/manual-reconcile mechanisms;
2. a verifiable commission/sponsorship disclosure standard existing on the C-end first;
3. booking_saga_fsm edge tables and effect-interpreter write-effect policies;
4. tenant-level ledger isolation (#229/#237) and state-cli tenant/decimal boundaries (#236/#241/#243) already in main;
5. #227 Z3 lifecycle and #242 dsh-map-tools map regression passed Node24 typecheck, 3×240, full, and CI on the integration candidate, then merged and closed; the M6 proof must still bind its own final SHA, but closed issues are not listed again as Entry conditions.

These dependencies mean M5's design must be B2B-compatible, but they are not a reason to implement M6 early. This memo keeps only the walkthrough and the proof definition.

## 8. Overall plan awaiting founder approval

Recommend approving the following boundary set as a whole: agency embedding primary, destination tourism secondary; sponsorship/inventory/disclosure injected as plugins; traveler, sponsor, and BFF as three isolated subjects; zero diff on a fixed frozen `kernel-set`, with runtime actual-loading coverage and pre-declared functional-path coverage submitted separately; the commercial half of M6 Exit closed out by a real pilot contract.

- [ ] `YES approve the overall plan`
- [ ] `Change to: ________________`

Only an explicit YES or explicit approval of a revised draft satisfies P6 Exit. Named pilot subjects, scope, and contract fields remain TODO; P6 approval is not M6 Entry; implementation still waits for M5 Exit.

---

Only after approval may this document turn `frozen(date)`; before approval it stays draft. The implementation gate still waits for M5 Exit.
