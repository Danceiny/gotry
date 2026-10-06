[English](release-notes.md) | [简体中文](release-notes.zh-CN.md)

# GoTry Release Notes

> Changelog for users and developers. Latest at the top.

---

## Unreleased

---

## v0.2.0-rc.31 · 2026-10-06

**Why this release.** FlyAI setup required a terminal command, and generated files were hard to find again. This release puts configuration in the native Plugins → GoTry panel and adds a GoTry artifacts tab to the native right workbench ([#651](https://github.com/Danceiny/gotry/issues/651), [#653](https://github.com/Danceiny/gotry/pull/653)). The extension manifest stays paired at `0.2.0.31`; its behavior is unchanged.

### What's New (since rc.30)

- **Visual FlyAI configuration** — open the console, enter a masked key, verify and save, refresh status or clear configuration. Environment-provided keys are read-only. Failed verification and cancellation preserve the previous key; secret values never enter model tools or status responses.
- **Native artifact workbench** — browse history, handoff tickets and workspace files with search, pagination and native previews. Successful bounded renders produce file delivery cards. No additional Artifacts plugin is required, and browsing does not call a model.
- **Truthful extension diagnostics and terminal setup** — `doctor` distinguishes an installed extension from a connected browser session. The terminal setup shares the bounded verifier and propagates cancellation cleanly ([#652](https://github.com/Danceiny/gotry/pull/652)).

### Installation

Run `npx @danceiny/gotry@0.2.0-rc.31 web` (Node ≥ 22.15). Once `latest` points to this version, `npx @danceiny/gotry web` is equivalent; pin the exact version if your registry mirror lags.

### Acceptance boundary

Full-stack regression and installed-package browser checks cover saving, rejected-key preservation, clearing, artifact browsing and native delivery with isolated state and controlled upstream responses. These checks do not establish acceptance with a real FlyAI account. Publication is established only by a passing registry pull-back receipt.

---

## v0.2.0-rc.30 · 2026-10-06

**Why this release.** A deep-planning turn could hit its deadline, reject the draft write, and save only an open handoff ticket, while the final reply still promised a created file and a background planner ([#647](https://github.com/Danceiny/gotry/issues/647)). This release ties those promises to the actual write result and native job lifecycle, and makes the draft and final deliverable openable. The version remains paired with the extension manifest (`0.2.0.30`, enforced by `extension-tests`); the extension's behavior is unchanged.

### What's New (since rc.29)

**Fixes**

- **Deadline handoffs preserve the real draft result** — the pending draft write runs once before the turn converges. A failed write stays a failure; the native `present` tool can display a file that was actually created.
- **Background planning has an owned native job** — persistent hosts start a session-owned job and record its id. One-shot or executor-less launches remain queued. The planner keeps the original working directory, user answers and bounded evidence; repeated handoffs reuse the ticket. Startup failure, execution failure, timeout, cancellation and completion settle durably. Settlement waits for the full managed process range to exit; a cleanup-observation error explicitly reports that cleanup could not be confirmed. Stderr is not a successful planning deliverable.
- **Drafts and results can be opened and found again** — native file cards and side-panel preview expose the actual files, and the final result can be listed or read through GoTry artifacts by its ticket id.

**Release tooling (not in the npm package)**

- **OIDC publishes the tarball as a file path ([#645](https://github.com/Danceiny/gotry/pull/645))** — npm receives an explicit relative file path rather than interpreting the bare path as a git shorthand before the identity exchange.
- **Pull-back receipts preserve the publication route ([#644](https://github.com/Danceiny/gotry/pull/644))** — the docs follow-up records the workflow and its run URL when the workflow published the package.

### Installation

Run `npx @danceiny/gotry@0.2.0-rc.30 web` (Node ≥ 22.15). Once `latest` points to this version, `npx @danceiny/gotry web` is equivalent; pin the exact version if your registry mirror lags.

### Acceptance boundary

The handoff regression and isolated browser checks use synthetic model and planner responses with real native jobs, managed processes, notifications and file presentation. Installed real-session acceptance for #647 still requires loading the fix; the original unexecuted ticket remains unexecuted.

### Published

Published to npm on 2026-10-06 as `@danceiny/gotry@0.2.0-rc.30` with `TAG=latest ./scripts/publish-npm.sh` (tag passed explicitly, #50①), then pulled back from the registry: `npm view` shows `latest` → `0.2.0-rc.30` (shasum `6a9cd57e7ec3361909fb91e0037ed180297a91e6`, 547 files) — the shasum `npm pack --dry-run` predicted from the tagged tree before publishing — and the downloaded tarball hashes to it. On a clean machine (fresh HOME and npm cache, official registry only, no LLM key) `npx @danceiny/gotry@0.2.0-rc.30` passes end to end: `doctor` prints its report, the dist entry loads the `gotry-tools` plugin, `web` boots (token URL 303 → 200, no token 401), and a one-shot without credentials fails with the host's missing-credential message rather than a stack trace. GitHub Release: [v0.2.0-rc.30](https://github.com/Danceiny/gotry/releases/tag/v0.2.0-rc.30). The compatibility `rc` tag is still on `0.0.1-rc.20`.

---

## v0.2.0-rc.29 · 2026-10-06

**Why this release.** rc.28 turned a solver crash into an explicit `solver_error` instead of a false "your trip is infeasible" ([#620](https://github.com/Danceiny/gotry/issues/620)). That left the bundled Yunnan pack ending in a `solver_error` instead of a plan: its `yn0` leg (Kunming → Lijiang after the 8.4 landing) has no calibrated buffer or transfer minutes, and only the founder can supply those ([#635](https://github.com/Danceiny/gotry/issues/635)). The pack now solves over its four attached legs and keeps `yn0` as advisory. The release also finishes the Chrome Web Store rename inside the product: `doctor`, the setup and wizard text and the tool descriptions now say Stai Travel Bridge, the name the listing has carried since it went live on 2026-10-04. The version stays paired with the extension manifest (`0.2.0.29`, enforced by `extension-tests`); the extension's behavior is unchanged.

### What's New (since rc.28)

**Fixes**

- **The bundled Yunnan pack solves again ([#635](https://github.com/Danceiny/gotry/issues/635))** — `yn0` moves from `legs` to a new `advisory_legs` section of `data/yunnan-pack.json`, with its reason stated: its buffer, origin-transfer and destination-transfer minutes are real-world facts only the founder can calibrate, and nothing is invented in their place. No reader consumes `advisory_legs`, so the parser, the solver and the kernel-pinned files are untouched. Before, `solveUnified` on this pack returned `solver_error` (`solver_input_not_integer`); the product's own pure-TypeScript `solveChoiceSegment` entry was never affected. Once the three minutes exist, putting `yn0` back into `legs` is the whole change. A test now audits every shipped pack for the three integer fields, and the persona dry run's Yunnan row is `feasible`.
- **One name for the extension: Stai Travel Bridge (#637)** — after the listing was renamed, the setup and wizard lines, the needs-extension summaries, the `doctor` item label and the channel and tool descriptions still said "GoTry Session Bridge". They now say what the Chrome Web Store shows. The store link and the extension's identity are unchanged. A script that matches the old `doctor` label text must use the new one.

**Release tooling (not in the npm package)**

- **The npm release is one verified command (#641)** — `scripts/publish-npm.sh` runs a preflight that lists every blocker before the first approval click. "Published" is gated on a registry pull-back receipt, and the GitHub Release and the docs follow-up both read that receipt. CI can be dispatched on a tag, so a tag commit whose push run was cancelled can still carry its own proof. The procedure is `docs/ops/npm-release-runbook.md`.
- **A publish workflow for npm Trusted Publishing (#642)** — `.github/workflows/npm-publish.yml` is dispatch-only and rehearses by default. It lets a release run with no approval click and no npm credential, and the job that holds the identity runs nothing installed after checkout. It needs a one-time Trusted Publisher setting on npmjs.com, and until a real run has passed, the command above stays the path of record.

**Housekeeping**

- **Five more trackers closed as deferred (#20, #136, #137, #142, #272)** — closed as *not planned* on 2026-10-05: M4–M6 are not the product's core capability for now, and the Booking Copilot acceptance waits for a logged-in Dida browser window and an authorized UAT deploy. Closing is not acceptance: every gate stays unmet, and the authority docs carry each resume trigger and the acceptance that carries over (#639).
- **README, user guide and roadmap baselines follow rc.28 (#640)** — rc.28 is recorded as published and pulled back from the registry.

### Installation

Run `npx @danceiny/gotry@0.2.0-rc.29 web` (Node ≥ 22.15). Once `latest` points to this version, `npx @danceiny/gotry web` is equivalent; pin the exact version if your registry mirror lags.

### Published

Published to npm on 2026-10-06 as `@danceiny/gotry@0.2.0-rc.29` with `TAG=latest ./scripts/publish-npm.sh` (tag passed explicitly, #50①), then pulled back from the registry: `npm view` shows `latest` → `0.2.0-rc.29` (shasum `7edbfe609b42bcb3482984c5fe4e139b898e7568`, 543 files) — the shasum `npm pack --dry-run` predicted from the tagged tree before publishing — and the downloaded tarball hashes to it. On a clean machine (fresh HOME and npm cache, official registry only, no LLM key) `npx @danceiny/gotry@0.2.0-rc.29` passes end to end: `doctor` prints its report, the dist entry loads the `gotry-tools` plugin, `web` boots (token URL 303 → 200, no token 401), and a one-shot without credentials fails with the host's missing-credential message rather than a stack trace. GitHub Release: [v0.2.0-rc.29](https://github.com/Danceiny/gotry/releases/tag/v0.2.0-rc.29). The compatibility `rc` tag is still on `0.0.1-rc.20`.

---

## v0.2.0-rc.28 · 2026-10-05

**Why this release.** The rc.27 pull-back and the simulated-trigger drills turned up real defects. `npx @danceiny/gotry doctor` reported an hbcli without credentials as "credentials valid" on every machine with hbcli installed ([#623](https://github.com/Danceiny/gotry/issues/623)); on the ground-transfer path a provider's raw error text could reach tool results unredacted, and a route provider that contradicted its own mode or resolved origin/destination was still bound as the airport transfer (#429); a solver crash could reach a traveller as "your trip is infeasible" ([#620](https://github.com/Danceiny/gotry/issues/620)); and the tenant ledger leaked raw SQLite contention errors to callers ([#619](https://github.com/Danceiny/gotry/issues/619)). All of them are fixed here. The release also lands the session dual-zone memory (default off) and the M3 capture and persona-simulation harness (synthetic only). The version stays paired with the extension manifest (`0.2.0.28`, enforced by `extension-tests`); the extension itself is unchanged.

### What's New (since rc.27)

**Fixes**

- **`gotry doctor` stops reporting an hbcli without credentials as "credentials valid" ([#623](https://github.com/Danceiny/gotry/issues/623))** — the CLI judged by the exit code of `hbcli auth whoami`, which is 0 even when nothing is configured, so every machine with hbcli installed saw a false "valid" (14 of 14 runs on the published rc.27). It now parses the three-tier `whoami` JSON exactly as the tool-layer doctor does, settles its probes on `close`, and a parity test feeds the same fake hbcli to both implementations so they cannot drift apart again.
- **`doctor` no longer intermittently reports an hbcli without credentials as `ok`** — the credential probe settled on the child's `exit` event, which can fire before its stdout has been read; an empty read then fell into the "unparseable output counts as valid" branch. It now settles on `close`, and a deterministic regression test injects a child that exits before its data arrives. This also removes an intermittent red on the Node 22 CI job.
- **Provider fault detail is scrubbed before it reaches tool results (#429)** — a ground-transfer provider's error text (markup, credential-shaped strings) no longer flows verbatim into `transfer_evidence`; the fixed `GROUND_TRANSFER_*` messages pass through byte-identical.
- **A route provider that contradicts its own request is refused instead of bound (#429 GAP-429-1/2)** — a declared mode other than driving, or a resolved origin/destination more than about 11 m from the requested pair (or one that cannot be parsed), falls back to the static transfer estimate with its original price label and writes nothing to the cache; the wired driving tool declares neither, so its behaviour is unchanged.
- **A solver crash is no longer reported as an infeasible trip ([#620](https://github.com/Danceiny/gotry/issues/620))** — `solveUnified` validates every integer before it reaches Z3 and returns an explicit `solver_error` (`solver_input_not_integer` / `solver_runtime_error`) instead of a fake `unsat_core: ['wasm_runtime_error']`, and the traveller-facing text says the solver failed rather than that the trip is impossible. The root cause on the Yunnan pack is a data gap (leg `yn0` has no buffer or transfer minutes), not a threading race, so that pack reports `solver_error` until its minutes are calibrated ([#635](https://github.com/Danceiny/gotry/issues/635)).
- **The tenant ledger no longer leaks raw SQLite contention errors ([#619](https://github.com/Danceiny/gotry/issues/619))** — `openDb` installs `busy_timeout` before the WAL switch and creates or migrates the schema under `BEGIN IMMEDIATE`, every read-then-write ledger transaction takes the write lock up front, and an exhausted budget surfaces as the typed `LedgerBusyError` instead of a bare `SQLITE_BUSY` / `SQLITE_BUSY_SNAPSHOT` (the D-15 drill defects D15-1 and D15-2). Stored data, schema, idempotency keys, event shapes and single-writer behaviour are unchanged. The kernel manifest was re-pinned for `state-ledger.ts` and `unified.ts` with founder approval.
- **A stalled LLM provider no longer hangs real-LLM runs ([#618](https://github.com/Danceiny/gotry/issues/618))** — `chat()` ends any request that has not fully answered within `GOTRY_LLM_TIMEOUT_MS` (default 300 s), or whose caller `AbortSignal` fires, as a typed `LlmRequestError` (`timeout` / `aborted`) instead of waiting forever; usage accounting and the missing-usage fail-closed rule are unchanged.
- **Offline switch for the realtime `hbcli` channel ([#617](https://github.com/Danceiny/gotry/issues/617))** — `GOTRY_HBCLI_LIVE=0` (also `false` / `off`) makes `anythingSearch` spawn no `hbcli` and degrade with `[实时API:hbcli-anything@offline@…]`; unset or any other value is unchanged (live when `hbcli` is available). `nightly-evidence.ts --dry-run`, `persona-sim.ts`, `replay.ts`, `replay-async.ts` and `time-eval-tests.ts` now default it to `0` (an explicit value is respected), so mock and dry-run paths no longer reach a live backend with the developer's stored credentials.
- **Release script creates the GitHub Release with `--verify-tag`** — `scripts/publish-npm.sh` passed the tag name as `gh release create --target`, which GitHub rejects (HTTP 422, `target_commitish is invalid`): the rc.27 publish succeeded on npm but its Release step failed and had to be created by hand. `--verify-tag` aborts if the tag is missing from the remote instead of silently creating one on `main`.
- **Test hardening** — the warmer-proof gate marker is published atomically (intermittent Node 24 failure) and the boot-budget proof allows a 50 ms early-fire tolerance on its 10 s handshake deadline (a Node 22 run measured 9999 ms).

**New, default-off or synthetic-only**

- **Session dual-zone memory mechanism (#255, default off)** — six log-type event kinds on the existing `events` table (zero new tables; the kernel-pinned `state-ledger.ts` is untouched), a capture seam, a scope-keyed read-back variable `session_zone_brief`, owner-confirmed promotion routed through the existing motivation/timeline/companion gates, `state-cli export` views `hot-context.jsonl` and `notebook.json`, and an opt-in observation face with three metrics whose thresholds are frozen before any data. The `sessionZones` switch defaults to `off` and is inert when off; the value claim stays closed (no real usage yet), and the shipped persona does not reference the new variable until the founder decides.
- **M3 cohort capture CLI and LLM persona simulation harness (#22, synthetic only)** — an operator-driven capture path for invited, consented seed participants that writes the scorer's `gotry_m3_cohort_record_v1` (the first producer of those records), and a persona-simulation harness that rehearses the funnel offline or with a real LLM under a budget gate. Simulated runs are labeled `synthetic_fixture`, enrolled as `test_or_staff`, and can never contribute to M3/M4 evidence; the M3 gate is unchanged (an admitted real 50–200 seed-user set is still required).
- **Simulated-trigger drills for the dormant trigger-gated trackers (#82, #275, #422, #340, #339, #429; fixture level; the trackers have since been closed as deferred)** — default-off, zero-caller contract mechanisms for transaction-outcome-versus-estimate projection (#340), city×scenario tiering with an empty registry (#339) and a route-provider conformance gate (#429); drill suites for the inert W2A sensor path (#82), concurrent writers, crash/reopen and online backup on the tenant ledger (#275) and the dsh SDK descendant-cleanup re-baseline on `0.2.0-rc.2` (#422, gap confirmed); and an opt-in, read-only measurement probe for the external Anything path (#276/#345). Every result is labeled `simulated_trigger_drill` or `fixture_contract` and none satisfies a trigger.

**Housekeeping**

- **Eight dormant trigger-watch issues closed as deferred (#82, #275, #422, #340, #339, #429, #276, #345)** — none of their triggers has fired, and the simulated-trigger drills satisfy none of them; leaving them open as a standing backlog was unhealthy. Closed as *not planned*, not completed: each trigger condition now lives in its authority document (architecture D-15 / §10 / D-39, `decisions-needed`, `memory-design` §2, `data-sources`), and a new issue opens when a real trigger appears.

### Installation

Run `npx @danceiny/gotry@0.2.0-rc.28 web` (Node ≥ 22.15). Once `latest` points to this version, `npx @danceiny/gotry web` is equivalent; pin the exact version if your registry mirror lags.

### Published

Published to npm on 2026-10-05 as `@danceiny/gotry@0.2.0-rc.28` with `TAG=latest ./scripts/publish-npm.sh` (tag passed explicitly, #50①), then pulled back from the registry: `npm view` shows `latest` → `0.2.0-rc.28` (shasum `62631ba3fd0c8d2e73227abc7d968e313e4283f3`, 543 files) — the shasum `npm pack --dry-run` predicted from the tagged tree before publishing — and the downloaded tarball hashes to it. On a clean machine (fresh HOME and npm cache, official registry only, no LLM key) `npx @danceiny/gotry@0.2.0-rc.28` passes end to end: `doctor` prints its report and no longer reports an hbcli without credentials as valid (the [#623](https://github.com/Danceiny/gotry/issues/623) fix), the dist entry loads the `gotry-tools` plugin, `web` boots (token URL 303 → 200, no token 401), and a one-shot without credentials fails with the host's missing-credential message rather than a stack trace. GitHub Release: [v0.2.0-rc.28](https://github.com/Danceiny/gotry/releases/tag/v0.2.0-rc.28). The compatibility `rc` tag is still on `0.0.1-rc.20`; moving it needs a separate web approval per tag (#50③).

---

## v0.2.0-rc.27 · 2026-10-04

**Why this release.** The published `latest` (`0.0.1-rc.24`) cannot start `gotry web` on a clean machine: its pinned DSH runtime (`0.1.5-rc.1`) fails at startup with `user patch-layer watching requires the Cordis HMR service` ([#600](https://github.com/Danceiny/gotry/issues/600)). This release moves the whole DSH family to `0.2.0-rc.2` (279 packages, [#610](https://github.com/Danceiny/gotry/pull/610)), which no longer contains that startup path. The founder confirmed the release on 2026-10-04. The version stays paired with the Stai Travel Bridge extension version `0.2.0.27` (extension-version invariant).

### What's New (since rc.24)

- **First-run fix** — a clean-machine `npx @danceiny/gotry web` boots again on the `0.2.0-rc.2` DSH closure; the previous closure crashed at startup in clean-machine runs of the web profile.
- **Itinerary artifacts** — deck renderer and static export bundle with a real QR matrix, product entries `gotry_itinerary_deck_render` and `gotry_itinerary_render` (HTML), host-owned Lavish review tools, artifact list paging with literal metadata search, the share-contract layer and the one-tap session-link contract (contract level, default off).
- **Realtime and session retrieval** — FlyAI: all public search kinds, safe setup checks, bounded process cleanup, fail-closed on malformed or terminated results; independent searches now run in parallel with bounded cancellation. Dida: city-plus-date query chain, destination driving, portal-delivered one-time login auto-fill, English room names. Session bridge: extension client binding for login-check-then-search, job-failure classification instead of false `needs-login`, redacted transport shapes for drift diagnosis, job ledger and event uplink.
- **Embedded Booking Copilot planner** — typed-decision and authority hardening, search-invalidation receipts, deployable turn deadlines, warm start and stall budgets; the planner's own process start has its own tight budget and error type, so a startup failure is no longer reported as a model timeout.
- **Memory and recall** — recall tick scheduler and why-now cards; tenant-ledger repair control plane (apply and rollback with receipts); the session dual-zone memory partition contract (P4-1, inert and default off).
- **Observability** — structured verdict logs and planner/backend startup-stage markers on the service runtime; boot diagnostics keep the ordered stage records ([#511](https://github.com/Danceiny/gotry/issues/511)).
- **Capability onboarding** — plain-language failure reasons when a channel such as `hbcli` is missing, a first-contact prompt that states the impact, a bilingual onboarding doc.
- **hbcli** — customer email-code two-step login tool surface.
- **Inert, default-off contracts** — the external-event (W2A) seam, the Money/FX fact contract and the offline administrative-atlas loader. None activates a live path.
- **Stai Travel Bridge is live on the Chrome Web Store (0.2.0.27, #346/#537)** — v0.2.0.26 was rejected on 2026-09-26 because the listing metadata did not match the observed behavior; the listing was renamed Stai Travel Bridge and v0.2.0.27 was resubmitted on 2026-09-30. The public store page and the store update endpoint both serve 0.2.0.27 (pulled back 2026-10-04). The installed-extension checks — desktop connection, employee-portal join and Dida login — remain open under #346.

### Previously queued items (carried from the former Unreleased list)
- **Persistent default departure city (#338, 2026-09-10)** — `gotry_motivation_save` accepts a typed `homeCity` with optional/explicit exact `homeCityEvidence` binding (a single non-empty evidence may be omitted; multiple require explicit); the ledger persists `homeCityPreference { value, evidence, updated_at }` and reads it back as a soft default via `{{motivation_brief}}`. An explicit current-turn departure city takes precedence; explicit null clears the active default.
- **Artifact views enter the M4 queue (issue #285, 2026-09-10)** — `gotry_artifacts_list/read` persist standard `presentationMeta` at the Host layer and output the fields required by `SearchPathsResultView`/`ReadResultView` plus `FileLocation`; **the published `./client` adapter renders custom list/read keyed cards in DSH Web via `window.__ModuleLoader__.load` keyed on the runtime `block`** (wire name `tool.call.toolview`, key = `gotry_artifacts_list` / `gotry_artifacts_read`, see `client/client.js`), with clickable paths, first line showing source + full path + line-number preview + source identity + content version; the workspace/sidebar file tree remains an **additional** preview surface. Read-scope whitelist = stateRoot root + session dsh working directory (excluding node_modules/.git); extension whitelist = text types; cross-root / symlink escape / missing file / oversize file (>2MB) uniformly return ok:false + error + hint. This layer is read-only; the WriteGate red line is not involved. Acceptance evidence = `scripts/artifacts-capability-tests.ts` 12 isolated-fixture proofs + `scripts/dsh-artifact-web-e2e.ts` fresh-profile Web list→select/open→read→edit→updated-read proof (covering the changed-file notice with correct preview after rewrite, and update visibility after reload) + smoke §15/§15b. Delivered via PR #305 / destination `48c794c58b02d543be01f3bec98a056447dfeb85`.
- **M4→M6 public delivery and debt ledger (#270)** — architecture debt rows uniformly point to a public tracker or concrete trigger conditions; D-12/D-16/D-24 archived; the issue→Draft PR→exact-head review→merge/destination receipt becomes the general public delivery contract. Local/fixture evidence still does not constitute real admission for #20/#136/#137.
- **DSH runtime closure migrated to 0.1.5-alpha.1 (#268)** — precisely migrated the root-pinned DSH runtime dependency from `0.1.2-alpha.3` (216-package closure) to `0.1.5-alpha.1` (230-package closure). The target version is pinned exactly, never following the mutable `alpha` dist-tag (currently pointing at `0.1.5-alpha.2`). 230 = 15 additions (`dsh-api-workspace-files`/`dsh-client-file-upload`/`dsh-client-resources`/`dsh-client-ui-open-in-app`/`dsh-client-ui-sidebar-files`/`dsh-client-ui-sidebar-right`/`dsh-client-ui-sidebar-textpreview`/`dsh-host-open-in-app`/`dsh-http-proxy`/`dsh-package-manifest`/`dsh-session-format`/`dsh-session-format-catalog`/`dsh-session-format-v0-to-v1`/`dsh-session-format-v1-to-v2`/`dsh-session-format-v2-to-v3`) + removal of `dsh-tool-subagent-report`; the add/remove set is confirmed by regenerated npm and pnpm lockfiles. `ts/package.json` overrides expanded from 14 to 230, pinning the full peer closure at `0.1.5-alpha.1` and preventing the `^0.1.5-alpha.1` caret from drifting transitive peers to `0.1.5-alpha.2`. Added failing-precondition contract test `dsh-target-closure-proof.ts` (reads the repo's actual state; must fail on the starting 216/alpha.3 closure, must pass after migration), wired into run-all §23b. API audit (`tsc --noEmit` + smoke + map-tools clean-tarball proof) reproduced no target incompatibility: the `SettingsProvider.prototype.installSection` seam, the 7 `map_*` tools, settings watch/reload/dispose, Session V3 one-way migration, and the agent/session/inbox/steer seams all survive on `0.1.5-alpha.1`, with no behavior change. Historical `0.1.2-alpha.3` evidence is retained in old §9/roadmap/stage1/release-notes entries, not batch-replaced; settings behavior unchanged. These deterministic proofs do not constitute M5/M6 admission. (Later superseded: the closure is now `0.2.0-rc.2`.)
- **TS strict install closure (#202)** — on top of rc.20, which already shipped the MIT `dsh-map-tools` in the package, completed the exact overrides for the alpha.3 peer closure so that a bare `npm ci` in `ts/` no longer depends on `--legacy-peer-deps`; added clean-tarball fail-closed proof.

### Installation

Run `npx @danceiny/gotry@0.2.0-rc.27 web` (Node ≥ 22.15). Once `latest` points to this version, `npx @danceiny/gotry web` is equivalent; pin the exact version if your registry mirror lags.

### Published

Published to npm on 2026-10-05 as `@danceiny/gotry@0.2.0-rc.27` with `TAG=latest ./scripts/publish-npm.sh` (tag passed explicitly, #50①), then pulled back from the registry: `npm view` shows `latest` → `0.2.0-rc.27` (shasum `f0889a78cd817bb33028630b9087177cc81c3ed2`, 517 files). On a clean machine (fresh HOME and npm cache, official registry only, no LLM key) `npx @danceiny/gotry@latest web` boots and serves the UI — the `Cordis HMR service` startup crash is gone — `doctor` prints its report, and a one-shot without credentials fails with the host's missing-credential message rather than a stack trace. GitHub Release: [v0.2.0-rc.27](https://github.com/Danceiny/gotry/releases/tag/v0.2.0-rc.27). The compatibility `rc` tag is still on `0.0.1-rc.20`; moving it needs a separate web approval (#50③).

Known issue in this version: `npx @danceiny/gotry doctor` reports an hbcli without credentials as "credentials valid" — the CLI still judges by the exit code of `hbcli auth whoami`, while the tool-layer doctor already parses its JSON ([#623](https://github.com/Danceiny/gotry/issues/623)).

---

## v0.0.1-rc.24 · 2026-09-11

**Source-only bump. The owner (founder) authorized the npm publish of `0.0.1-rc.24` after the docs/audit-sync-2026-09-11 batch closed; the bump advances `package.json` and `extension/manifest.json` together. Source commits covering this version:**

- `6e85d36` feat(session): execute in admin browser extension, kill server-side chrome (#380) — founder 2026-09-11: execution environment = the browser client (GoTry Session Bridge), server-side zero Chrome. `ts/capabilities/session/extension-bridge.ts` extracts transport-agnostic `createBridgeJobQueue`; `handleMountedRequest` mounts gotry-backend `/v1/session/bridge/{health,status,jobs,results}` auth surface. `ts/capabilities/session-search.ts` introduces `multiCollect` for the dida recommended-flow lane (`hotels` + `recommendPrices` both arriving = settlement). `ts/src/backend/modules/session-search.ts` drops the CDP/transport dependency and exposes only the bridge endpoints; `login/open` lets the extension bring the dida login page to the front. Founder directive "hide all config from employees; portal dispatches join ticket" moves the hotelbyte product's `join ticket` dispatch out of the CLI surface. §38 extension-contract tests 36/36.
- `25502e9` feat(state-ledger): authorized tenant repair apply/rollback with receipt protocol (#254) (#378) — extends `ts/src/ledger-repair-apply.ts` with owner-gated `apply` / `rollback` paths, paired with the receipt protocol from `docs/ops/ledger-tenant-repair.md`. Dry-run still default; production apply requires the explicit owner-only `GOTRY_REPAIR_AUTHORIZE` env token and writes a private receipt on completion.
- `3168c0f` chore(deps): DSH runtime closure upgraded to 0.1.5-rc.1 (232 packages) (#379) — `ts/package.json` overrides expanded from 14 to 232, pinning the full peer closure at `0.1.5-rc.1`. New additions include `dsh-client-ui-sidebar-files`/`dsh-client-ui-sidebar-right`/`dsh-client-ui-sidebar-textpreview`; removals: `dsh-tool-subagent-report`. CI explicitly strict with `npm ci --strict-peer-deps`.
- `c28d6be` fix(ci): backfill version field for native binary placeholders in lockfile — three `node-addon-system-*` placeholder entries under `node_modules/@deepseek-ai/node-addon-system/` had no `version` field, causing `npm ci --strict-peer-deps` on npm 11.19.0 to fail with `Invalid Version:`. Backfilled with `0.1.2` matching the parent package's `optionalDependencies`. Unblocks the docs-only PRs (#383 + the audit-sync follow-ups) that were CI-failing despite being pure docs changes.

### What's New (architecture-side increments shipped alongside)

These were merged into `main` between rc.20 and rc.24 but are not in their own release segment because the author intentionally held them in the Unreleased queue pending the rc.24 batch closure:

- **Web startup interactive onboarding (#258/#267)** — `npx @danceiny/gotry web` on an interactive TTY may ask **exactly once** "configure now? (y/N)" before the detached doctor summary fires. `y` reuses `doctor --fix`'s idempotent installers (`setupHbcli` / `setupReach` / `setupSidebar`); `n` proceeds to web. Three-class results (`installed` / `needs-user-action` / `unavailable`). CI / benchmark / non-TTY / `GOTRY_SETUP_SKIP=1` / `GOTRY_ONBOARDING_SKIP=1` / `--no-onboarding` all skip the prompt. **M4 UX proof**; does not count toward #20's real `observed_private` cohort Exit.
- **Booking Copilot planner shared-source derivation (#263, 8 commits)** — `time-anchor.ts` exports `formatUtcOffsetLabel` with fixed `UTC±HH:MM` zero-pad; `validation.ts` exports the canonical schema bytes; the planner persona's `SearchCriteriaPatch` property-name list is derived from `bookingSurfaceSchema.$defs.SearchCriteriaPatch.properties` — no hand-maintained second copy. Numeric-keyed arrays (`{"0": {...}}`) are detected at the must-be-array repair step. Planner LLM follows `DEEPSEEK_MODEL` / `LLM_MODEL`; MiniMax-M2 nested decision envelopes auto-unwrapped; planner token budget raised for reasoning models.
- **Booking planner correction batch (#212 / #278)** — `#212` factRef alias-collision prevention via reserved `modelref:` namespace + SHA-256 of raw UTF-8; `#278` schema-rejection feedback loop replays the concrete rejection into the same session instead of blind-retrying the identical prompt (MiniMax-M3 reproducer); occupancy entries invented without `adults` dropped. Predecessor slice to `#282`.
- **Dida supplier-portal adapter v2 (#372)** — recognizes the load-state recommended flow (`HotelRecommendAPI/SearchHomepageRecommendHotels` + `SearchHomepageRecommendPrices`) in addition to `PopularDestinationAPI/SearchHotels` + `SearchHotelPrices`. UAT probes found this is what the page spontaneously emits. CDP lane uses windowed multi-response collection.
- **Booking-executor observation surface (#377, M1 slice 1)** — `POST /v1/booking/observe` only; opens the supplier page via CDP, reads the booking-entry button text, captures a screenshot. Deliberately no fill/submit primitives (those belong to a future controlled-executor behind M5 WriteGate).
- **gotry-backend release build script (#367)** — `scripts/build-booking-copilot-release.mjs` + `scripts/build-gotry-backend-release.mjs` wrap the kernel + booking-copilot + session-search modules into the published artifact for `bin/gotry-backend.js`.

### For Developers

- All new behavior lives behind the same idempotent installer surface as `doctor --fix`; no new global state, no new configuration paths.
- Booking-copilot planner prompts now share the canonical schema with the booking.surface typed contracts — drift between the planner example and the wire shape is a compile error rather than a runtime mismatch.
- The lockfile backfill in `c28d6be` is a 6-line fix; if you regenerate `package-lock.json` via `npm install`, the same three placeholders will re-emerge without `version`. The author of `c28d6be` plans to add a `prepublish` lint that rejects empty-version entries; track in the next audit batch.

### Installation

- No change — run `npx @danceiny/gotry@0.0.1-rc.24 web`. The first interactive start runs the #258/#267 onboarding prompt once; pass `--no-onboarding` or set `GOTRY_ONBOARDING_SKIP=1` to skip it.

### dist-tag plan

`npm dist-tag add 0.0.1-rc.24 latest` and `npm dist-tag add 0.0.1-rc.24 rc` in the same authorized publish window (per owner directive, dist-tag c: dual-point both `latest` and `rc`). Granular token DELETE returns 403/405 as documented in [`docs/tokens.md`](../tokens.md); the redundant `rc` alias remains attached at rc.20 — owner decision pending whether to keep the historical `rc` point or let it die.

---

## v0.0.1-rc.20 · 2026-09-08

### What's New

- **Fixed the entire install chain behind `npx @danceiny/gotry doctor --fix`** — rc.19 field testing showed three reds and one false positive, each with a different root cause:
  - **The sidebar's "1 item failed to install" was a false positive**: pnpm 11's strict build-script policy made the dsh installer exit 1, but all 167 packages had actually landed on disk in full (the recheck was green all along). The installer now judges success by on-disk state, and explicitly notes that the build script of node-pty (the sidebar's embedded terminal) was skipped by pnpm and can be approved with `pnpm approve-builds` when needed.
  - **Map/route/POI tools are truly usable this time (npm install form)**: rc.19 said "officially in dependencies", but that only took effect for the source layout — the npm layout never got them installed. The dependency path was blocked upstream: dsh-map-tools' peer requires the dsh family at `>=0.1.2-rc.1`, while gotry pins `0.1.2-alpha.3` (semver: alpha < rc), so npm's strict peer resolution refused the install outright, and forcing it would break the main `npx @danceiny/gotry` install path. rc.20 switches to **in-package bundled distribution** — installing gotry gives you the map tools, zero API key (OSM/OSRM).
  - **ask-user's ❌ was a health-check false positive**: the dependency was there all along (in npm's hoisted layout, runtime fine), but the health check's probe paths didn't cover that layout. The health check now resolves with the same semantics as the runtime and tells the truth.
- **`gotry help` no longer prints merge-conflict markers** (dirty text introduced in rc.19, cleared in passing).

### For Developers

- **CI two-layer fix (main fully red since #197)**: ① after the runner's npm upgrade, a bare `npm ci` enforces peer validation, while ts's lockfile has always been generated in `--legacy-peer-deps` mode — CI and CONTRIBUTING now pass that flag explicitly, and the redundant dsh-map-tools dependency was removed; ② turn-deadline's 5 tsc errors = the type surface implicitly depended on accidental peer materialization (the `session/event` declaration lives in dsh-session's cordis Events augmentation; under pnpm's isolated layout the root-side augmentation merged into a different cordis instance) — explicit `import type` + dsh-session@0.1.2-alpha.3 into the ts dependency surface, overrides pin the peer closure at alpha.3 against rc.1 version mixing, and the ts lock fully resolves back to registry.npmjs.org.
- Both doctor faces (CLI + session tool) switched to a createRequire resolution chain covering the npm/npx hoisted layout; map-tools resolution prefers vendor first.
- New regression anchors: doctor-tests §5b/5c (hoisted-layout resolution / vendor layout) + bootstrap-tests §11 (installer exits non-0 but landed on disk = judge success by state).

### Installation

- No change — run `npx @danceiny/gotry web`. rc.19 users: run `npx @danceiny/gotry doctor` once to recheck — the map/ask-user pair should turn green.

---

## v0.0.1-rc.19 · 2026-09-07

### What's New

- **Fixed rc18's hard error `invalid skill name "gotry_motivation_save"`** — in the boundary scenario of "check balance + plan a trip", the model would pass gotry's tool names to the host skill loader as if they were host skills, erroring on the spot. The persona contract now hard-writes the surface rule: all gotry capabilities are tool calls (`gotry_` prefix), never entering the skill loader; if a skill call reports invalid/unknown, switch back to a tool call.
- **Map/route/POI tools shipped** — `dsh-map-tools` officially enters dependencies (zero API key, via OSM/OSRM open source). Previously this plugin was silently dropped by the startup flow; now the doctor health checks (in-conversation `gotry_doctor` and terminal `npx @danceiny/gotry doctor`) both truthfully tell you whether it is in place.
- **External-event seam (first two segments)** — added a read-only channel-probe tick: out-of-band facts like "site down / upstream unreachable" are now written into the channel health surface; retrieval rerouting suggestions and doctor benefit immediately, without waiting for users to hit the failure; wish pool recall also falsifies aspirations whose "depended-on channel is currently unavailable" — no longer hard-pushing itineraries that cannot work right now.
- **booking planner continuous hardening** — a batch of fixes: factRef pointer cleanup generalization, truncated finalResponse recovery, UI preloaded-offers tolerance, surface-policy violation retry, etc. (#172-#188).
- **doctor both faces same semantics** — terminal CLI and session tool face now report the same health-check list (previously the CLI lacked the map-tools/ask-user pair).

### For Developers

- Channel health surface adds `'ok'` recovery event semantics (latest-wins overrides down); external-event seam design `docs/design/external-event-seam.md`: the first two of three segments landed, the third (world2agent remote bridge) awaits the D-31 decision.
- run-all adds §52 (channel probe) / §53 (wish pool falsification) / §54 (persona surface guardrail); the behavior contract remains 22 items ((16) internal clarification).
- Node floor remains 22.15 (startup refuses anything below it).

### Installation

- No change — run `npx @danceiny/gotry web`.

---

---

## v0.0.1-rc.18 · 2026-09-02

### What's New

- **Fixed a bug that left you stuck in the terminal** — previously, if no LLM key was set when `gotry web` started, the CLI printed a "missing LLM API key" message and exited outright, never entering dsh at all. But the key is dsh's business and gotry should not gate it. Startup now just silently delegates to dsh.
- **`gotry setup` no longer manages other dependencies for you** — it used to conveniently install a pile of gotry-unrelated tools like hbcli / agent-reach / dsh-better-sidebar; now it checks exactly one thing: is the browser extension installed. Everything else belongs to its own host ecosystem.
- **Docs sync the de-keying guidance** — README in both Chinese and English, plus `user-guide.md`, no longer tell you to "write LLM_API_KEY in .env".

### For Developers

- This release is mainly about "making gotry more plugin-like at the CLI layer" — it no longer pretends to be the entry point, and no longer asks users to configure things it was never supposed to manage.

### Installation

- No change — run `npx @danceiny/gotry web`; dsh pops up whatever it needs to pop up.

---

## v0.0.1-rc.17 · 2026-09-02

### What's New

- **GoTry Session Bridge is live on the [Chrome Web Store](https://chromewebstore.google.com/detail/gotry-session-bridge/oeajpiccmonococjcegddlooeeohlbgd)** — the browser extension passed Google review and is published: one-click install, auto-update, zero system popups.
- **Plugin installation goes back to being the browser's job** — previously gotry opened the browser, touched the clipboard, and popped native panels all from the terminal, making the install experience terrible. Now you just open the browser store and click "Add to Chrome" and it's done. When the `gotry session` tool hits an extension-not-installed state during session retrieval, it presents the store link directly to you — one click and you're there.
- **Ctrip (携程) session-face install with fewer pitfalls** — previously, calling Ctrip session retrieval without the extension installed would hang; now, once the extension is installed, the conversation resumes automatically right away.
- **GitHub Releases channel retained** — if you want to control your own update cadence, or don't want to go through store review, you can still pull the latest version in the terminal with `npx @danceiny/gotry setup --extension-from=github`.

### For Developers

- **Extension install prompt is now seamless** — previously, when an extension install was needed, users had to run a long command in the terminal; now gotry's tool results carry the Chrome store link directly, and the client UI you build can render it as a clickable link.
- **Chrome store version and locally-loaded version fully interoperate** — both channels use the same extension and the same data bridge, so even if you switch from the developer-mode loaded version to the store version mid-way, or the reverse, sessions never break.

### Installation

- Recommended: open [chromewebstore.google.com/detail/gotry-session-bridge/oeajpiccmonococjcegddlooeeohlbgd](https://chromewebstore.google.com/detail/gotry-session-bridge/oeajpiccmonococjcegddlooeeohlbgd) in your browser → "Add to Chrome".
- After installation, start gotry; if a tool's first call still needs the extension, it auto-detects — no restart needed.

---

## v0.0.1-rc.16 · 2026-08-30

### What's New

- **Newly onboarded MiniMax model family rates** — the rate table previously covered only one vendor; now several MiniMax models are onboarded too, computing the true cost of each conversation for you more accurately. Model upgrades are automatically billed at the new rates.
- **Automatically monitor pricing changes across major vendors** — the pricing of four major vendors (DeepSeek, MiniMax, OpenAI, Anthropic) is scanned periodically. If you were using one before, it may be re-priced automatically, but **it will never automatically change your config** — that still requires human confirmation.
- **Changelog goes machine-generated from here** — this changelog still carries plenty of human traces; starting with the next version it will be auto-generated from code commit records. The "What's New" you see will be the real changes from the development process, not after-the-fact tidying.
- **Fixed an extension problem that made re-running error out** — previously, in some cases, running gotry repeatedly caused port-occupation conflicts that needed several manual restarts to reproduce; not anymore.

### For Developers

- **Release process became stable** — before every release, the full test suite now runs automatically, the changelog is checked, and a clean install is verified; these used to be manual and easy to miss.

---

## v0.0.1-rc.15 · 2026-08-29

### What's New

- **The booking flow state machine now has a formal vocabulary** — when gotry performs booking-related multi-step operations (e.g., rebooking, cancellation, confirmation), it now uses only a pre-defined set of actions. This is so that multi-step operations can later be fully replayed and safely audited, with no fuzzy zone of "which step did it actually get to".

### For Developers

- This release mainly lays the foundation for the next-generation "order-placement-capable" ability; no visible change for end users.

---

## v0.0.1-rc.14 · 2026-08-29

### What's New

- **Docs now have separate Chinese and English versions** — the repo-root README now comes in one English copy and one Chinese copy; read whichever language you're comfortable with. The npm homepage shows English.

---

## v0.0.1-rc.13 · 2026-08-29

### What's New

- **Automatic login detection** — every time the `gotry session` tool needs to reuse your already-logged-in Ctrip account, it now first quietly reads the fact "am I logged in". If yes, it searches directly, without popping a login every time. Only if you're not logged in does it open the login page for you to log in.
- **The login page is more decisive** — previously the login page sometimes opened where you couldn't see it; now it always switches your browser focus to the login page, so you know where it is after logging in.
- **Never proactively opens the browser** — gotry's self-check flow will no longer flash-quit your browser or repeatedly open a pile of windows just because tests ran; unless you explicitly enable live mode.
- **README rearranged into a version ordinary people can understand** — the top recommends a 30-second quickstart, grouped into three sections: "what to search, what to use, how to use"; the four hard rules on account authorization and privacy are pulled out and emphasized separately.

---

## v0.0.1-rc.12 · 2026-08-29

### What's New

- **Hotel search connected to OTA (Fliggy (飞猪) official)** — previously hotel lookup could only use gotry's own internal data; now it can directly search real-time prices on Ctrip and Fliggy. This is read-only search, zero credentials, and will not place orders for you.
- **OTA tool surface is flat** — no more internal-concept distinctions like "this is the primary path, this is the fallback"; from the frontend it's just a row of side-by-side tools, each usable.
- **Tools that touch your account pop a confirmation card first** — any tool that uses "your Ctrip account" greets you first on its first call in each session — usable only after approval, remembered within this session; if you decline, this session won't pop again and won't execute either.
- **Login is now a tool** — previously login jumped to the command line; now you call `gotry_session_login` directly inside gotry, and it opens the login entry page in your own browser — just finish logging in as usual. **Login always happens on Ctrip's official site; gotry never touches your password, verification code, or cookie values** — it only glances at the boolean fact "logged in or not".

---

## v0.0.1-rc.11 · 2026-08-29

### What's New

- **Root-cured the Z3 compute engine's concurrency race** — previously, under certain stress scenarios, there was a hidden problem of repeated solve failures requiring one retry; now it's thoroughly fixed and safe to run concurrently.
- **Real-time fares optionally enabled** — off by default. If your model or scenario needs real-time quotes, set `GOTRY_REALTIME_PRICING=1` in the environment, and gotry verifies actual flight prices against Fliggy official and overwrites them into the answer; when no exact fare is found it falls back to the static package, never pretending to be real-time.
- **English output** — gotry's Chinese/English UI switch is now fully landed; switch with `GOTRY_LOCALE=en`.
- **README's previous four "known limitations" — two cleared** — the real-time fare bridge and the English UI both completed in this release.

---

## v0.0.1-rc.10 · 2026-08-28

### What's New

- **Web and local share one ledger semantics** — if you later want to deploy gotry as a multi-user Web service, it shares the same data foundation as your own local use; who the user is becomes a first-class column in the ledger, but you won't see any difference in the single-user phase.
- **One-line broadcast** — last version's "installed but won't run" problem on first post-install launch now leads to the full npm install flow instead of smearing a crash stack across your face.

### For Developers

- **Root cure for rc.9's installed-but-not-running extension** — the extension installed by rc.9 had a hidden bug that made the npm form unable to load the extension after install; rc.10 both root-cures it and bakes this check into the pre-release mandatory preverification script.
- **Dependency surface completed** — the package now bundles SQLite (ledger), puppeteer-core (browser debugging), and several DeepSeek dsh family dependencies pinned by peers.

---

## v0.0.1-rc.9 · 2026-08-28

### What's New

- **17 tools** — the memory domain (motivation profile, travel timeline, companions, time-window decay), the transactional state foundation, and the session face (Ctrip official + cross-verification with your own account) converge; this is 30 commits from the development mainline merged at once.
- **Places you've already been are no longer pushed at you** — the motivation profile and travel history now start feeding into recommendation demotion.
- **Holiday anchors extended to 2031** — the "time anchors" for long holidays like Spring Festival, Mid-Autumn, and National Day are no longer missed by the presets.

---

## Earlier versions (rc.8 and earlier)

rc.8 was the first release with the "memory domain + time-awareness hardening" skeleton; rc.7 was the final version that completed the 7-question reconciliation on real user conversation data; earlier (rc.1 to rc.6) were internal iterations. If you're jumping up from an earlier version, the key changes are:

- Currently recommended install: `npx -y @danceiny/gotry@latest` (or `@rc`)
- Ctrip session retrieval requires the browser extension — see the rc.17 section above
- All external dependency installs converge into `npx @danceiny/gotry setup`

---

## Still unresolved (may still affect you)

- **Real-user sample evidence not fully collected** — for M3 (internal milestone codename, "product basically usable") to count as truly complete, we need finalization rate, NPS, and geographic Q&A hallucination rate measured across multiple real seed users; currently 0.
- **Session face only covers Ctrip (flight/hotel/train)** — Meituan (美团) local is still a blind spot (anonymous 403; logged-in state is a hard prerequisite).
- **The English UI still has small tails** — after switching to English, a very small number of corners still have untranslated Chinese.
- **Real-time pricing is off by default** — turning it on is slightly slower end-to-end than the static package; if you don't mind, leave it on.
