[English](extension-webstore-submission.md) | [简体中文](extension-webstore-submission.zh-CN.md)

# GoTry Session Bridge — Chrome Web Store Submission Materials (ADR-21 Distribution Track B)

> Status: **Live on the store (2026-09-02, v0.1.0 approved and published)**. Store page:
> https://chromewebstore.google.com/detail/gotry-session-bridge/oeajpiccmonococjcegddlooeeohlbgd
> Artifact: `node scripts/package-extension.mjs` → `dist-extension/gotry-session-bridge-store.zip`
> (manifest at the zip root; uploaded directly in the store console). The icon is uploaded
> separately in the store console; it is not in the zip.
>
> **Store field test (the plan held)**: the store re-signs with its own generated signing key and
> **ignores the fixed key in the manifest** — the store extension ID is
> `oeajpiccmonococjcegddlooeeohlbgd` (the item ID, i.e. the last segment of the store page URL),
> different from the unpacked fixed ID `olpgkofjhhiiiahdkkbcninhjmegghfe`. The impact landed
> exactly as this document predicted:
> the local bridge Origin whitelist now trusts both channels (`EXTENSION_ORIGINS` in
> `extension-bridge.ts`, covered by the run-all §38 regression); the extension code and manifest
> needed no changes (the port pool / host whitelist do not drift with the channel).

## Why the store (platform constraints)

Chrome forbids ordinary users from installing a packaged CRX from an arbitrary URL: GitHub
Releases can only improve "download"; it cannot remove the 3 clicks of "developer mode → load
unpacked". **One-click install + auto-update has exactly one path: the Chrome Web Store**. The
store build and the unpacked build have different extension IDs (the store re-signs; see above);
both IDs belong to the same founder-controlled extension, and the bridge whitelist trusts both;
the port pool (8791-8795) and the host whitelist are unchanged.

## Single Purpose statement (required by review)

> On the user's own Ctrip (携程) flight-search pages, read-only sniffing of the search responses
> issued by the page itself and of the **names** of login-ticket cookies, handed over the local
> loopback port (127.0.0.1) to the user's local GoTry program, to reuse the user's sign-in state
> for cross-validation of itinerary data under the user's explicit authorization. The extension
> performs zero writes and sends zero data off the machine.

## Permission justifications (required by review)

| Permission | Justification (paste-ready) |
|---|---|
| `cookies` | Reads only cookie **names** to determine sign-in state (the "search only when signed in" user gate). Never reads, stores, or transmits cookie values; login is always completed by the user on the Ctrip website. |
| `alarms` | Keeps the MV3 service worker alive (scheduling of the long-poll keep-alive interval); touches no data plane. |
| `http://127.0.0.1:8791-8795/*` | Loopback communication with the user's local GoTry process (search task dispatch / response hand-back). Local only; never the open internet. |
| `https://*.ctrip.com/*` | Passive sniffing of the batchSearch responses **issued by the flights.ctrip.com page itself** (passive MAIN-world listening; the extension initiates and modifies no requests); cookie-name reading also happens on this domain. |
| content_scripts (flights.ctrip.com, dual world) | MAIN-world passive sniffing + isolated-world bridging to the local loopback; neither rewrites the page nor injects UI. |

## Privacy disclosures (Privacy tab)

- No personally identifiable information is collected; nothing is sold, shared, or used for third-party purposes; no analytics/ad SDKs.
- The only data flow: fragments of page search responses and cookie **names** → the local GoTry process at 127.0.0.1; nothing lands in the cloud.
- Privacy policy URL (required in the console): `https://github.com/Danceiny/gotry/blob/main/docs/extension-privacy.md`

## Store listing copy (paste-ready)

- **Name**: GoTry Session Bridge
- **Short description** (≤132 characters): Read-only sniffing of flight search results inside your own sign-in state, handed to local GoTry for itinerary cross-validation. Zero credentials handled, zero writes, zero data leaves the machine.
- **Description**: GoTry is a local-first AI travel assistant. This extension is its optional data bridge: after a one-time install, GoTry can run read-only flight searches inside **your own** Ctrip sign-in state (cross-validating official-channel results), with no browser debugging port and no system-level permission dialogs. Read-only: it sniffs the page's own search responses, reads only cookie names to determine sign-in state, and never reads values, never writes, never uploads. Switch it off at any time from the extension card. See the repository README for details.
- **Category**: Travel; **Languages**: Chinese (Simplified) + English

## founder submission checklist (in order) — completed (live on the store 2026-09-02)

1. ~~Chrome Web Store developer registration (one-time $5, Google account).~~
2. ~~`node scripts/package-extension.mjs` produces the store zip; prepare the 128×128 icon and 1280×800 screenshots (uploaded separately in the store console).~~
3. ~~Create item → upload zip → paste the copy / permission justifications / privacy disclosures above → point the privacy policy URL at the repository privacy document.~~ The current reader entry point is [extension-privacy.md](extension-privacy.md); this path correction does not mean the store console URL has been updated.
4. ~~Submit for review~~ → approved and published (v0.1.0).
5. Post-approval landing: bridge Origin whitelist trusting both channels (landed, `EXTENSION_ORIGINS` + §38); the Node side keeps the extension file / `manifest.key` precheck, and `sessionFlightSearch` / `sessionLogin` hand `installUrl` / `installAction` to the dsh UI on `needs-extension`; the old wizard no longer carries installation duty. The GitHub Releases channel (Track A) is kept as the review-free / versioned / rollback / mirror channel.

## Later releases (store channel)

- Store-build update: bump `version` in `extension/manifest.json` → `node scripts/package-extension.mjs` → upload the new zip in the devconsole and submit for review.
- GitHub channel update: the three-piece `ext-*` tag release assets (tar.gz / store-zip / dist-manifest), pulled by users via `npx @danceiny/gotry setup --extension-from=github`.

## How the three channels relate

| | Chrome Web Store (recommended) | GitHub Releases (no review) | In-npm copy (offline fallback) |
|---|---|---|---|
| One-click install | ✓ | ✗ (3 clicks in developer mode) | ✗ (same as left) |
| Auto-update | ✓ (with store releases) | ✗ (`--extension-from=github` pulls new versions manually) | ✗ (with npm releases) |
| Review cost | Registration + review | None | None |
| Versioning / rollback / mirror | ✗ (store cadence) | ✓ (Release assets + SHA256) | ✗ |
| Extension ID | `oeajpiccmonococjcegddlooeeohlbgd` | `olpgkofjhhiiiahdkkbcninhjmegghfe` | `olpgkofjhhiiiahdkkbcninhjmegghfe` |

## 2026-09-09 changes pending submission (dida supplier portal)

- `manifest.json` changes: host_permissions adds `https://*.dida.com/*` and `https://dida.com/*`; both content_scripts groups add `https://portal.dida.com/*`.
- Trigger: `gotry_session_search kind=dida` (the hotel-be portal integration line) needs dida-domain injection and read-only login-ticket cookie-name permission.
- **The store submission is tracked by [#346](https://github.com/Danceiny/gotry/issues/346)**; **founder decides whether / when / which version to bump** (founder-confirm regime, see `tech-strategy.md` §11 and the release discipline in `AGENTS.md`); **packaging / devconsole upload / status tracking / verification** are executed by the release executor under the repository release discipline; founder only completes the account-side personal approval / 2FA as required. Before the store build lands, store users calling dida get needs-extension (same as any brand-new site); the existing ctrip/12306 lanes are unaffected.
- The unpacked / GitHub Releases channels are unaffected by store review; merging the `feat/session-dida-portal` branch takes effect immediately (PR #297 is merged; code and manifest are already in place).
- **Current evidence boundary**: the repository holds no receipt of this submission or of a store pull-back verification; external state is tracked by [#346](https://github.com/Danceiny/gotry/issues/346).
