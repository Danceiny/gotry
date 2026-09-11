[English](release-notes.md) | [简体中文](release-notes.zh-CN.md)

# GoTry Release Notes

> Changelog for users and developers. Latest at the top.

---

## Unreleased

- **Persistent default departure city (#338, 2026-09-10)** — `gotry_motivation_save` accepts a typed `homeCity` with optional/explicit exact `homeCityEvidence` binding (a single non-empty evidence may be omitted; multiple require explicit); the ledger persists `homeCityPreference { value, evidence, updated_at }` and reads it back as a soft default via `{{motivation_brief}}`. An explicit current-turn departure city takes precedence; explicit null clears the active default.
- **Artifact views enter the M4 queue (issue #285, 2026-09-10)** — `gotry_artifacts_list/read` persist standard `presentationMeta` at the Host layer and output the fields required by `SearchPathsResultView`/`ReadResultView` plus `FileLocation`; **the published `./client` adapter renders custom list/read keyed cards in DSH Web via `window.__ModuleLoader__.load` keyed on the runtime `block`** (wire name `tool.call.toolview`, key = `gotry_artifacts_list` / `gotry_artifacts_read`, see `client/client.js`), with clickable paths, first line showing source + full path + line-number preview + source identity + content version; the workspace/sidebar file tree remains an **additional** preview surface. Read-scope whitelist = stateRoot root + session dsh working directory (excluding node_modules/.git); extension whitelist = text types; cross-root / symlink escape / missing file / oversize file (>2MB) uniformly return ok:false + error + hint. This layer is read-only; the WriteGate red line is not involved. Acceptance evidence = `scripts/artifacts-capability-tests.ts` 12 isolated-fixture proofs + `scripts/dsh-artifact-web-e2e.ts` fresh-profile Web list→select/open→read→edit→updated-read proof (covering the changed-file notice with correct preview after rewrite, and update visibility after reload) + smoke §15/§15b. This item has no tag or npm release yet; current final delivery target = PR #305 / destination `48c794c58b02d543be01f3bec98a056447dfeb85`.
- **M4→M6 public delivery and debt ledger (#270)** — architecture debt rows uniformly point to a public tracker or concrete trigger conditions; D-12/D-16/D-24 archived; the issue→Draft PR→exact-head review→merge/destination receipt becomes the general public delivery contract. Local/fixture evidence still does not constitute real admission for #20/#136/#137.
- **DSH runtime closure migrated to 0.1.5-alpha.1 (#268)** — precisely migrated the root-pinned DSH runtime dependency from `0.1.2-alpha.3` (216-package closure) to `0.1.5-alpha.1` (230-package closure). The target version is pinned exactly, never following the mutable `alpha` dist-tag (currently pointing at `0.1.5-alpha.2`). 230 = 15 additions (`dsh-api-workspace-files`/`dsh-client-file-upload`/`dsh-client-resources`/`dsh-client-ui-open-in-app`/`dsh-client-ui-sidebar-files`/`dsh-client-ui-sidebar-right`/`dsh-client-ui-sidebar-textpreview`/`dsh-host-open-in-app`/`dsh-http-proxy`/`dsh-package-manifest`/`dsh-session-format`/`dsh-session-format-catalog`/`dsh-session-format-v0-to-v1`/`dsh-session-format-v1-to-v2`/`dsh-session-format-v2-to-v3`) + removal of `dsh-tool-subagent-report`; the add/remove set is confirmed by regenerated npm and pnpm lockfiles. `ts/package.json` overrides expanded from 14 to 230, pinning the full peer closure at `0.1.5-alpha.1` and preventing the `^0.1.5-alpha.1` caret from drifting transitive peers to `0.1.5-alpha.2`. Added failing-precondition contract test `dsh-target-closure-proof.ts` (reads the repo's actual state; must fail on the starting 216/alpha.3 closure, must pass after migration), wired into run-all §23b. API audit (`tsc --noEmit` + smoke + map-tools clean-tarball proof) reproduced no target incompatibility: the `SettingsProvider.prototype.installSection` seam, the 7 `map_*` tools, settings watch/reload/dispose, Session V3 one-way migration, and the agent/session/inbox/steer seams all survive on `0.1.5-alpha.1`, with no behavior change. Historical `0.1.2-alpha.3` evidence is retained in old §9/roadmap/stage1/release-notes entries, not batch-replaced; settings behavior unchanged. This item has no tag or npm release yet; these deterministic proofs do not constitute M5/M6 admission.
- **TS strict install closure (#202)** — on top of rc.20, which already shipped the MIT `dsh-map-tools` in the package, completed the exact overrides for the alpha.3 peer closure so that a bare `npm ci` in `ts/` no longer depends on `--legacy-peer-deps`; added clean-tarball fail-closed proof. This item has no tag or npm release yet.

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
