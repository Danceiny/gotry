[English](tool-orchestration-design.md) | [简体中文](tool-orchestration-design.zh-CN.md)

# Tool Orchestration and Channel Health Face Design (closeout of issues #106/#107/#108 + two core propositions)

> Status: **accepted, fully landed** (D-7/D-8/D-9 adopted on 2026-09-03; L0/L1 landed the same day, the seven L2 items closed out on 2026-09-04 — see §6).
> Related: ADR-13 (tool envelope) / ADR-18 (effect interpreter) / ADR-19 (fact typing) / ADR-24 (turn budget) / ADR-25 (channel health face);
> `effect-interpreter.md`; `../data-sources.md` (authoritative data-source doc); evaluation-track issues #96/#100/#102.

## 0. What this document answers

1. A unified design for all tool-call issues among the open issues: #108 (session bridge priority / tool orchestration),
   #107 (TOOL_BUDGET_EXHAUSTED / quota ownership), #106 (bootstrap onboarding / glob timeout); it also states the
   relationship to #96/#100/#102 (evaluation track, tool contracts from the same source) and #82 (world2agent event face).
2. Core proposition 1: how to **durably** preserve tool-call "performance", including under ordinary LLMs.
3. Core proposition 2: how to keep the tool ecosystem open with the highest degree of extensibility.

## 1. The shared root cause of the three issues

The three issues fail in different shapes but share one root cause: **at the moment of failure, the model holds no
structured channel state and no next-step guidance** —

| issue | failure shape | missing piece |
|---|---|---|
| #108 | flyai 429 quota exhausted; the model blind-retries across turns, unaware that session bridge is the stronger fallback | channel state (quota exhausted) + rerouting guidance (the next-best channel) |
| #107 | web_fetch/flyai hits TOOL_BUDGET_EXHAUSTED; the user gets no answer | ownership definition and visibility of quota (invisible before exhaustion); the symptom layer already cured at the root by ADR-24 v2 |
| #106 | dsh-calendar reports "username not configured" mid-session; glob/grep timeouts | bootstrap onboarding for patch-distribution-face host plugins; glob/grep belongs to upstream dsh (no anchor in this repo) |

The existing foundation (not rebuilt; we only close out on top of it):

- **ADR-13 flat envelope** (`tool-packet.ts`): success/failure share one shape, guard fallbacks share it too — every
  tool return is already a structured carrier, so rerouting guidance has a place to live.
- **ADR-18 effect interpreter + resilience policy table** (`effect.ts`/`resilience.ts`): effects as data, per-effect
  backoff/circuit-breaker decisions made explicit, mock interpreter; "429 no-retry goes to needs-setup" is landed (flyai.ts).
- **ADR-19 fact typing** (`bookable-facts.ts`): miss≠error, transport failures never write negative facts
  (the invariant required by issue #96 is implemented, see §3.4).
- **ADR-24 v2 turn budget** (`turn-policy.ts`): deterministic routing (quick/sync/deep, zero LLM) +
  wall-clock dual exits (converge/handoff) — the "budget exhausted, bare death" shape is cured at the root (#107 symptom layer).
- **needs-setup verdict + two-layer explicit tool descriptions** (defeb5b): on reaching the limit, guidance arrives: "do not retry, switch to X".
- **doctor health-check face** (`capabilities/doctor.ts`): the unified exit for optional-dependency status and install guidance.

The root cause reduces to four gaps:

1. **Channel state is implicit** — scattered across error strings, persona prose, and tool descriptions; no first-class data face;
2. **Routing knowledge lives only in prose** — persona (19) is nearly a thousand characters of prose; strong models can read it, ordinary models cannot;
3. **Quota is invisible** — you learn of exhaustion only at the moment it happens; no prediction, no explanation;
4. **Bootstrap onboarding covers only gotry's own dependencies** — patch-distributed host plugins (dsh-calendar etc.) are outside its coverage.

## 2. Design overview: channel registry (data) + channel health face

Two new first-class data faces; everything else is **generated** from them (not a new parallel source of truth):

### 2.1 Channel registry `channel-registry` (pure data, single source)

Each row describes one channel:

```
{ id: 'flyai' | 'session:ctrip-flight' | 'session:12306-train' | 'hbcli' | 'open-meteo' | …,
  intents: ['search-flight', …],            // intents covered (see §3.3 intent vocabulary)
  quotaClass: 'user-session' | 'user-key' | 'anonymous-trial' | 'free-public' | 'static',
  evidenceTier: '[实时API:*]' | '[会话:*]' | '[静态包:估算]',   // basis for the reliability ordering
  setup: { surface: 'doctor#flyai' | 'extension-store' | 'cordis.patch.yml', … },
  fallbacks: ['session:ctrip-flight', 'web'],  // candidate order within an intent (static initial value)
  probe?: 'doctor item id'                   // health-probe anchor
}
```

Consumers (all generated, zero hand edits): ① the replacement fragment for persona (19); ② the first line of each
retrieval tool's description (applicable intents / degradation order); ③ the `routing` suggestion field in tool
results (§3.3); ④ doctor report lines. Adding a channel = one registry row + one handler + one test assertion —
persona/descriptions/doctor become consistent automatically. This is the physical basis of Proposition 2 (§5) and the
landing point of Proposition 1's "prose rots, generated artifacts do not".

### 2.2 Channel health face (channel health)

Two granularities, both derived from existing verdict flows; no new runtime:

- **Persistent face = doctor v2**: health-check items extend from "is it installed" to "is the quota-class channel
  healthy right now" — read the most recent needs-setup/429 timestamp from the incident/fact sidecar and show a status
  at the "limit reached today / half available" level; plus a new section for patch-distributed host plugins (§3.1).
- **Session face = session channel-state** (in-process transient, same precedent as the circuit breaker, never persisted):
  when a channel returns needs-setup / challenged / cooldown / needs-extension, record
  `{channel, state: down|degraded, reason, since}`; afterwards, tool results for related intents **within the same
  session** get one `routing` suggestion line injected at the tail (see §3.3). No proactive broadcast at turn start
  (no token burn); teaching happens only at the failure site or on related retrieval results — the contract is taught
  at the failure site, not previewed in the system prompt.

### 2.3 Compatibility argument with ADR-18 "no automatic multi-channel routing" and persona (19) "flat, no preset priorities"

This design **does not touch** those two founder rulings: the tool face stays flat, the interpreter does no hidden
dispatch, and the model still picks tools and issues calls by itself. What changes: ordering is no longer a **static
preset** (exactly the "three-level routing" persona (19) deleted) but a **dynamic suggestion driven by runtime health
state** — the pathology of #108 is not "no static priority" but "no mechanism carried the state change of flyai's
exhausted quota into the model's next choice". Static flatness + dynamic suggestions satisfies both historical rulings
(transparency, auditability, agent-layer price comparison) and this issue's demand (availability-first orchestration).
The alternative "interpreter-level automatic rerouting" is still ruled out: it breaks call auditability (the model
believes it called A while B actually ran) and violates the transparency principle isomorphic to WriteGate.

## 3. Per-issue design

### 3.1 #106 — bootstrap onboarding extends to the patch distribution face; glob/grep belongs upstream

**Fact correction**: triage claimed "the gotry code face has zero references to dsh-calendar"; at the **distribution
layer** this does not hold — `cordis.gotry-patch.yml` lines 15-16 distribute that plugin, `bin/gotry-inner.js` resolves
and injects it at runtime, and the comment knowingly states "when unconfigured, the tool errors and degrades, without
blocking startup". That is: gotry voluntarily shipped a **known-unconfigured** tool into the model's toolbox, and the
error surfaced mid-session — exactly what issue ① reasonably demands: "complete installation and configuration together
at initialization". Triage's grep scope covered only persona/tool descriptions/docs, not the distribution face.

**Design**:

1. **doctor v2 adds a "host plugins" section**: for each patch-distributed host plugin
   (dsh-calendar / dsh-map-tools / dsh-tool-ask-user), check two states — resolvable (the same candidate list as the
   bin resolution logic) + configured (whether the calendar row's config in `cordis.patch.yml` has the calendar:profile
   username filled in; map-tools runs keyless, so only existence is checked); when unconfigured, give a precise fix
   (a copyable command or a patch-line example). The doctor contract — read-only, never throws — is unchanged.
2. **calendar not mounted by default** (recommended, needs decision D-9): gotry's only demand on calendar is work-window
   reading, and persona (1)'s interview already asks about the work window in the first round — an unconfigured calendar
   is pure negative asset (one more tool that errors). Mounting is managed by the **setup state face**:
   `~/.gotry/calendar.json` (cohabiting with the extension manifest under `~/.gotry`);
   `npx @danceiny/gotry setup calendar` enables, `--off` restores the default, `--status` shows state;
   **environment variables must not control product behavior** (founder correction 2026-09-03: optional dependencies
   must enter setup state management; env is not where product switches live); doctor guides configuration;
   fallback option: keep default mounting + doctor guidance (symptomatic fix; the model still hits one error before it knows).
3. **One-shot bootstrap summary**: at `npx @danceiny/gotry web`/headless startup, run one read-only doctor pass; if
   degraded/missing items exist, print a one-line summary (non-blocking, no repeated spam) — "visible at initialization"
   replaces "error hit mid-session".
3a. **#258/#267 interactive web-startup onboarding (M4 UX proof; #267 = post-merge hardening once #266 merged)**: at `npx @danceiny/gotry web`, and only with an interactive
   TTY + "auto-installable" gaps present (hbcli binary / agent-reach `.venv` / dsh-better-sidebar), ask once "configure
   optional capabilities now?" **before** the background summary above. `y` reuses the `doctor --fix` idempotent
   installers (setupHbcli/setupReach/setupSidebar, **no second set built**); `n` continues web startup immediately;
   results render in three states — `installed` (auto-installed on this machine) / `needs-user-action` (Chrome Web
   Store, hbcli login, FlyAI key, calendar profile, and other user/upstream authorizations; never faked as
   auto-completed) / `unavailable` (with a concrete reason, e.g. a vendored payload missing from the package requires
   reinstalling gotry). Partial failure does not block web and yields a retryable command
   (`npx @danceiny/gotry doctor --fix`); reruns do not reinstall already-healthy items (installer existence
   short-circuit + doctor recheck; idempotent). **When no auto-installable gaps exist but user-action/unavailable gaps
   do** (e.g. on win32 hbcli/agent-reach/sidebar have no auto-install face, or only credential/key/reinstall gaps
   remain): no prompt, no install, but render the classified plan (`needs-user-action` / `unavailable` item by item
   with concrete reasons; win32 gets a platform reason rather than an invalid `doctor --fix` pointer), flagged
   `reported`; inner uses this to suppress the duplicate detached background summary (the classified plan already shows
   the gaps). CI / benchmark / non-TTY / all-healthy / `GOTRY_SETUP_SKIP=1` / `GOTRY_ONBOARDING_SKIP=1` /
   `--no-onboarding` all start web with **zero prompts and zero installs**; never install inside postinstall or
   detached background tasks. The background summary line is kept only when onboarding neither prompted nor reported
   (no duplication). `installerEnabled` accepts injected env; the classifyDoctorGap/buildOnboardingPlan/runOnboarding
   chain depends nowhere on ambient `GOTRY_SETUP_*` (the production CLI path still takes process.env defaults).
   **#267 hardening**: the web-onboarding subprocess call changed from `spawnSync` to an awaited POSIX process-group
   `spawn` so JS can serve SIGINT/SIGTERM — the signal path terminates the currently active child process/process
   group and cleans the private result directory + patch directory (idempotent); the normal/error paths clean too; the
   bootstrap installer `run()` uses its own bounded process-group lifecycle, with inner's outer grace explicitly
   larger than the installer TERM+SIGKILL budget so a stubborn installer is not orphaned; the result channel changed to
   a 0700 `mkdtemp` private directory + `result.json` `mode 0600 + flag wx` (exclusive write, defends against symlink
   swap). Pure functions (classify/plan/skipReason) and runOnboardingFix (installers injected)/promptOnboarding/
   renderClassifiedPlan (stream injected) are exported for isolated unit tests in `bootstrap-tests.ts` — synthetic
   items + injected fakes; never run real installers / open a browser / write `ts/dsh-runtime/gotry-state`; §21 crosses
   the **real** inner→bootstrap onboarding→dsh-web process boundary with a temporary installer-package fixture +
   fake dsh + fixture-local TTY preload (the prompt is observed exactly once); §21c/§21f/§21g POSIX signal/timeout
   tests cover prompt-wait, accepted-install parent SIGTERM, and accepted-install onboarding timeout, proving the
   stubborn installer subtree and the result+patch directories all get bounded cleanup. **Boundary statement**: this
   item is an M4 UX proof with deterministic tests; it proves the install/repair contract and the prompt/skip/reported
   behavior; it does **not** satisfy #20's real repeat-cohort Exit evidence; fixture/local-install proofs do not count
   as M4 Exit evidence.
4. **glob/grep timeouts**: built into the dsh host; gotry has no action anchor on its side — keep the triage
   conclusion, file a separate upstream issue (if it still reproduces). This repo adds no proxy layer for it
   (reuse matrix: the harness layer is dsh proper).
### 3.2 #107 — quota ownership mechanism (taxonomy and degradation contract for quota-class tools)

The issue's real question (triage located it): **ownership and escalation path of upstream quota**, not gotry's
per-turn budget (already closed out by ADR-24 v2).

**Five-way quota classification** (goes into the channel registry's `quotaClass`; each class's ownership and
exhaustion semantics are frozen together):

| class | ownership | instances | exhaustion semantics |
|---|---|---|---|
| user-session | the user's own account | session bridges (Ctrip/12306) | the user's own quota; cadence gate (≥30s) + stop-on-challenge protection; never shifted onto the user |
| user-key | user-provided | FLYAI_API_KEY, hbcli credentials | the quota is a contract between the user and upstream; doctor shows validity |
| anonymous-trial | the product-sponsored funnel layer | flyai anonymous-trial shared pool | **positioning = first experience, not a production dependency**; at the limit → needs-setup + upgrade guidance |
| free-public | community fair use | open-meteo / OpenSky / OSRM | circuit breaker prevents idle spinning (already in the policy table); quota resets daily |
| static | no quota | built-in data packages | estimates must be labeled, never passed off as real-time |

**Ownership recommendation (D-7 decision)**: formal use always upgrades to user-key or user-session; **a unified
product-applied formal key pool is not being done now** — cost, abuse surface, and upstream ToS are three
unquantifieds; revisit when M3 real cohort scale appears. The anonymous trial pool keeps its "zero-friction first
experience" positioning, but its state must be visible (doctor quota probe, §2.2) — no longer "easy to exhaust yet
invisible".

**Session-level degradation policy** (the session face of the health face, §2.2): 429/needs-setup → mark this session
`flyai: down(trial-exhausted)` → later flight/train/hotel retrieval intents in the same session get
`routing: session → web` injected into tool results (§3.3). Nothing is remembered across sessions (re-probe each
session, so stale state cannot lock out the recovery path of a key installed afterwards — recovery signal = the next
successful call automatically clears the down state).

### 3.3 #108 — "dynamic programming" tool orchestration = intent×channel matrix × health state → suggested routing

Landing the founder's DP demand in an engineering-tractable form:

```
state   s = channel health vector (§2.2 session face) + quota class (§3.2) + per-channel evidence tier (registry static)
action  a = for intent i, choose channel c ∈ channels(i)
value   V(i,s) = lexicographic-max over c available in s of (availability, reliability=evidence tier, efficiency=cost/latency)
recursion  channels are mutually independent given a health state ⇒ no cross-intent coupling, optimal substructure holds;
       each intent's optimum = the first available channel in lexicographic order — DP degenerates into a health-state-driven ordered suggestion list
memoization = session channel-state cache (health state unchanged ⇒ the suggestion list is not recomputed)
```

Engineering shape (**suggestions, not dispatch**):

1. **Intent vocabulary** (closed set, the keys of the registry's `intents`): `search-flight | search-train | search-hotel |
   read-web | search-geo | weather | verify-flight | …` — each tool declares which intents it serves.
2. **Tool-result `routing` field**: when verdict ≠ hit (and only then), append to the ADR-13 flat envelope
   `routing: { intent, alternatives: [{tool, why, setup?}] }` — an order table computed from the current health state,
   each entry with a one-sentence reason ("flyai trial quota exhausted", "session face needs a one-time extension
   install"). Success results carry none (zero token cost); failure results carry it (exactly the moment guidance is
   needed).
3. **persona (19) slimming**: the near-thousand-character prose shrinks to a compact fragment generated from the
   registry — one line per intent "intent → channel order (with evidence tier)", plus one rule "when verdict≠hit,
   reroute per the in-result routing; explain to the user at most once per intent per session". The prose doctrine
   becomes a table-lookup doctrine.
4. **Generated first line of tool descriptions**: every retrieval tool's description uniformly opens with the generated
   "served intents / current order / non-applicable face" — the model sees the same table at both decision points:
   when choosing a tool (reading the description) and after failure (reading routing).

**Precise answer to "session bridge priority is too low"**: no static priority (persona (19) ruling kept); set a
**state-driven dynamic order** — when flyai has a key and is healthy, it is the first recommendation (zero setup
friction); the moment flyai's anonymous trial hits the limit, session rises to first recommendation with install/login
guidance attached. Priority is no longer a constant; it is a projection of the health face.

**Alternatives and rejections**: interpreter-level automatic rerouting (hidden dispatch) — rejected, reasons in §2.3;
putting "quota-exhaustion probability" into turn-policy routing — rejected, turn-policy is a pure function with zero IO
(control-plane iron law); health state enters via tool results, not through the classifier.

### 3.4 The evaluation track (#96/#100/#102) and its relation to #82

- **#96 (transport failure ≠ business miss)**: the required invariant is implemented (`bookable-facts.ts` —
  error/needs-setup never write facts; session-side eight-value verdict typing; `classifyTransportFailure`
  classification). Suggest the owner verify the two process items triage left (independent PR attribution,
  five-class counterexample coverage) and then close it. This design does not file a duplicate.
- **#102 (typed benchmark tool contracts)**: the "single typed descriptor → model-visible schema + pre-spawn
  validation" that the benchmark bridge is building and mechanism ③ in §4 are two ends of the same pattern — #102
  validates the pattern, and the product side adopts it afterwards (not waiting on it; two independent PR lines).
- **#100 (minimal kernel)**: the measurement face for ordinary-LLM performance (see the end of §4).
- **#82 (world2agent event-driven)**: a future seam — external sensor events become **new producers for the health
  face** (a site goes down → the channel state is set to down) and new trigger sources for wish pool conditions,
  consuming existing seams; no new runtime needed. Recorded as a compatible direction, not promised this cycle.
## 4. Proposition 1: how to durably preserve tool-call performance (including ordinary LLMs)

**Thesis: performance bets not on model cleverness but on a "deterministic control plane + self-healing contracts".**
This repo's existing positions (§3.5 "whatever backend engineering can solve is never handed to the LLM"; turn-policy
"control-plane judgments must be deterministic components") unfold fully on the tool-call face into six mechanisms:

1. **Judgment belongs to code; the model does only semantics**. Routing (turn-policy), budgets, the date gate, verdict
   typing, channel state, reroute order — all zero LLM. An ordinary model does not need to "understand the ecosystem";
   it only needs to read the next-step line instruction in the current result.
2. **Contracts are taught at the failure site**. Every failure carries its own recovery instruction: needs-setup comes
   with setup, challenged comes with "stop", miss≠error is stated separately, routing comes with an order table. A weak
   model's recovery does not depend on remembering the system prompt, because the instruction arrives in the same frame
   as the failure — the most important item for ordinary LLMs, and verified effective (after defeb5b, blind 429
   retries disappeared).
3. **Typed tool contracts productized** (the largest single lever for ordinary LLMs). Today the parameter face of the
   23 registered tools is an untyped blob `query: { type: 'json' }` — the model sees no per-field schema, so the gap
   between strong and weak models is fully exposed as "can it guess the parameter shape". dsh `defineTool` natively
   supports a typed ParameterSchemaSpec (object/properties/enum/const/required/oneOf; `validateArgs` validates before
   execute; `parameterSchemaSpecToJsonSchema` projects to a model-visible JSON Schema) — **the blob is this repo's
   choice, not an upstream limitation**. Migrate the high-traffic tools (flyai/session/hotel/weather first) to
   `type:'object'` + per-field constraints + `additionalProperties:false`: model-visible structure → ordinary models
   also get it right in one shot; host-side validation → malformed parameters are structurally rejected before execute
   (the rejection shape stays ADR-13 ToolFailure, locked by migration tests); `interpretArgs` remains as a
   legacy-shape tolerance layer.
4. **The health face makes state visible** (§2.2): the persistent face (doctor) answers "does this channel work on
   this machine"; the session face answers "what just happened to the channel in this session" — foresight replaces
   blind retry; explainability replaces dumb failure.
5. **Evidence-chain grading is the reliability declaration**. [实时API]/[会话]/[静态包:估算] labeled per source; the
   artifact fact gate (ADR-19) forces traceability — reliability is a declared contract, not model virtue, and does
   not drift with model generations.
6. **Incident → fixture loop**. Every real incident is sunk into a regression anchor the same day: Dubai 429 →
   needs-setup verdict; the wedding itinerary → turn-policy vocabulary and handoff; the Nanning telegraph code →
   first-party calibration of 129 cities + anti-drift assertions. Of the three evaluation layers (ADR-11), **the
   benchmark's frozen treatment (#100/#102, explicitly pinning ordinary models like deepseek-v4-flash) is the
   measurement gate for "ordinary LLM performance"** — every tool-contract migration carries one canary round as
   evidence; below bar, no merge.

"Durable" defined: all of the above is **structure** (code + data + tests), not prompt prose. Prose rots with each
model generation; a contract with tests does not rot — when rot happens, a test goes red, and red gets fixed.

## 5. Proposition 2: how to keep the tool ecosystem open at maximum extensibility

**Five open seams already in place** (not rebuilt): the effect registry (one handler row + one policy-table row + one
assertion; "no policy-table row, no effect"), session adapters (the Ctrip/12306 templates), the CLI-spawn capability
pattern (flyai/hbcli/anything are isomorphic: spawn→parse→verdict, never throws), the agent-reach reflection bridge
(upstream adds a channel, gotry changes nothing — "wrapper is not router"), patch host plugins
(map/calendar/ask-user).

**The design pushes openness up one more notch**:

1. **Channel registry + tool descriptor single source** (§2.1 and §4③ are two faces of the same thing): each tool =
   one descriptor (name/intents/typed params/verdict vocabulary/evidence template/quotaClass/healthClass)
   + one handler binding; `index.ts` shrinks from a 1500-line registry to an assembler. A third party (or a future
   agent itself) contributes a tool = descriptor + handler + tests; the review surface converges to the descriptor
   itself.
2. **persona/descriptions/doctor generated from the registry** (§2.1): adding a channel drops the number of prose
   sites to touch from N (persona + every tool description + doctor + docs) to 0 — **the measure of extensibility =
   the number of files needing hand edits to add one channel; target: 1 registry row + 1 handler + tests**.
3. **Session adapter contract documented**: 12306's first-party calibration method (official site tables / seat-bucket
   mapping checked item by item + verify snapshots + anti-drift assertions) is a proven template — write an adapter
   author's guide (probe → gold-standard fixture → dual-source shape gate → drift lock); community members and later
   comers add sites without touching the core. Adapters are the ecosystem's unit of extension.
4. **The reflection bridge as the default pattern**: new CLI-family capabilities default to discovery/reflection
   passthrough, no per-channel switch (the D-4a' founder correction rises to pattern discipline).
5. **Event face reserved** (#82): external events enter the health face and wish pool conditions, consuming existing
   seams.
6. **Faces that stay closed (the boundary is the trust)**: reuse-matrix hard constraints (code-level reuse only via
   open-source import; internal assets only bridge/reference); write tools always pass WriteGate (M5); extensibility
   stops at the write boundary; red lines travel with every contribution — any contributed tool writing the motivation
   profile must carry evidence; entering the wish pool requires conditions.

Open and trustworthy are not a trade-off: the registry/descriptors make "adding things" easier; the verdict vocabulary
/ evidence chain / WriteGate make "what gets added" automatically follow the same discipline — **the ceiling of
ecosystem openness is set by contract stiffness, not by tool count**.

## 6. Landing sequence (layered; one independent PR per layer)

- **L0 (pure docs/data face, zero behavior change)**: ✅ landed in 01e002c/9b7ad07 (channel registry +
  doctor v2 + calendar setup state face); #96 verify-and-close pending the owner.
- **L1 (contract migration, full-stack regression + six state faces synced)**: ✅ routing suggestion field + session
  channel state + persona (19) generated card (01e002c); the remainder moved into issues:
  #112 (typed parameter contract migration, D-30) / #113 (generated tool-description first lines + doctor host-plugin
  coverage).
- **L2 (peripheral closeout)**: ✅ all closed out (2026-09-04) — #114 (bootstrap startup health-check summary) /
  #115 (interpreter migration finish, D-23 discharged) /
  #116 (adapter author's guide + Ctrip real-session calibration, D-13) / #117 (store-version extension detection,
  D-24 discharged) /
  #118 (fact gate hotel claim + one-way generation of render primitives, D-26 closeout) / #119 (external event seam
  design, #82) /
  #120 (legacy vendored disposition, D-27 discharged).
- **#258/#267 (interactive web-startup onboarding, M4 UX proof; #267 = post-merge hardening once #266 merged)**: on
  top of #114's background summary, add one explicit optional-capability configuration prompt (see §3.1③a), reusing
  the `doctor --fix` idempotent installers, three-state results, and the strict skip contract;
  when no auto-installable gaps exist, render the classified plan + `reported` suppresses duplicate summaries (win32
  and other no-auto-install scenarios stay visible to the user);
  `installerEnabled` accepts injected env; pure functions + injected installers for isolated unit tests. #267
  hardening: the web-onboarding subprocess call became an awaited
  POSIX process-group `spawn` (SIGINT/SIGTERM servable; the signal path cleans result+patch directories), the
  bootstrap installer `run()` moved in step to a bounded process-group lifecycle, outer grace covering the installer
  TERM+SIGKILL budget; result channel 0700 `mkdtemp` + `0600/wx`,
  bootstrap-tests §21 crosses the real inner→bootstrap onboarding process boundary, §21c/§21f/§21g cover prompt-wait,
  accepted-install parent signal, and accepted-install timeout. **Does not satisfy #20's real repeat-cohort Exit
  evidence**
  (M4 UX proof, not a business Exit); D-34 discharged.

> Decision record: D-7/D-8/D-9 were adopted and landed on 2026-09-03 under "proceed to implementation" (issues #106/#107/#108 closed the same day);
> trigger-deferred items (D-15/D-18/D-19/D-22/D-29, M5 WriteGate, the unified product key pool) are not in this sequence — redemption timing: see architecture §10.

## 7. Decision-point summary (all settled; archived in `../decisions-needed.md`)

| # | topic | recommendation | related |
|---|---|---|---|
| D-7 | ownership mechanism for quota-bearing tools | trial = funnel layer; formal use = user-key/user-session; the unified product key pool deferred to the M3 cohort | #107 |
| D-8 | orchestration strategy | static flatness + health-state-driven dynamic suggestions (this design); no interpreter-level automatic rerouting | #108 |
| D-9 | dsh-calendar distribution | not mounted by default (setup state face `~/.gotry/calendar.json`, `npx @danceiny/gotry setup calendar` on/off; **env is not a product switch**) + doctor guidance; alternative: keep mounting + guidance | #106 |
