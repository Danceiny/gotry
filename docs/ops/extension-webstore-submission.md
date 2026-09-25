[English](extension-webstore-submission.md) | [简体中文](extension-webstore-submission.zh-CN.md)

# Stai — Chrome Web Store Submission Materials (ADR-21 Distribution Track B)

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

> Stai connects authorized Ctrip flight/hotel, 12306 rail, and Dida supplier-portal
> searches to GoTry. It relays page-produced search results and selected login-cookie
> **names** through the local bridge or an authenticated backend bridge supplied by the
> employee portal. That portal can also provide a one-time Dida login payload for
> form fill and submission. The extension does not book or pay.

## Permission justifications (required by review)

| Permission | Justification (paste-ready) |
|---|---|
| `cookies` | Selects specified cookie **names** for Ctrip or Dida sign-in checks; cookie values are not put in bridge results or persistent extension storage. |
| `alarms` | Keeps the MV3 service worker alive (scheduling of the long-poll keep-alive interval); touches no data plane. |
| `http://127.0.0.1:8791-8795/*` | Desktop bridge health, job polling and result delivery to local GoTry. |
| `https://*.ctrip.com/*` | Ctrip flight/hotel page response observation and login-state cookie-name checks. |
| `https://*.dida.com/*`, `https://dida.com/*`, `http://*.dida.com/*`, `http://dida.com/*` | Dida portal result observation and cookie-name checks, including the non-Secure session-cookie domain variants. |
| `https://portal.hotelbyte.com/*`, `https://portal-test.hotelbyte.com/*` | Employee-portal join-ticket and one-time supplier-login handoff. The portal issues a bridge path on its own origin; search results and status can leave the device in this mode. |
| content scripts on Ctrip, 12306, Dida and HotelByte pages | Observe matching page responses, hand off portal data, operate an authorized Dida search and fill/submit a portal-provided Dida login. |

## Privacy disclosures (Privacy tab)

- Declare page search content, page URL/title, login-cookie names, optional backend transmission and one-time supplier-login credential handling accurately. Do not claim "zero credentials", "local only" or "zero writes".
- In the data-use checklist, select **authentication information** and **website content**. Also select **personally identifiable information** when a supplier username can be an email address, and **web history** because the bridge can receive the current page URL and title. Do not select unrelated categories without evidence.
- The extension has no analytics/ad SDK; booking and payment are outside its scope.
- The portal restricts bridge URLs to its own origin. The old broad HTTP/HTTPS optional-host patterns were unused and have been removed from this candidate.
- Privacy policy URL (required in the console): `https://github.com/Danceiny/gotry/blob/main/docs/ops/extension-privacy.md`

## Store listing copy (paste-ready)

- **Name**: Stai (formerly GoTry Session Bridge)
- **Short description** (≤132 characters): Authorized travel search bridge for GoTry, with local or employee-portal backend delivery and supplier sign-in assistance.
- **Description**: Stai connects supported Ctrip flight/hotel, 12306 rail and Dida supplier-portal searches to GoTry. It observes matching search responses from the pages and checks selected login-cookie names, never forwarding cookie values. Desktop results go to local GoTry; an authenticated HotelByte employee portal can connect the extension to its backend, so search data can leave the device. The portal may provide one-time Dida credentials for in-memory login-form fill and submission; the extension does not persist those credentials. It may operate Dida search controls, but does not book or pay. You can disable the extension in Chrome. See the privacy policy for details.
- **Category**: Travel; **Languages**: Chinese (Simplified) + English

## Reviewer access

The dashboard's **Test instructions** fields are currently empty. The Ctrip desktop path can be checked with the public GoTry setup and a user-owned Ctrip session; the HotelByte employee-portal join and Dida one-time login require a separate review account. If that path is part of review, enter a dedicated test account directly in the dashboard's private credential fields and provide bounded steps in **Other instructions**. Never place credentials in this repository or a public issue.

## founder submission checklist (in order) — completed (live on the store 2026-09-02)

1. ~~Chrome Web Store developer registration (one-time $5, Google account).~~
2. ~~`node scripts/package-extension.mjs` produces the store zip; prepare the 128×128 icon and 1280×800 screenshots (uploaded separately in the store console).~~
3. ~~Create item → upload zip → paste listing/privacy disclosures.~~ The live listing's privacy URL still points to a moved path. Correct it to [extension-privacy.md](extension-privacy.md) in the dashboard before the next submission.
4. ~~Submit for review~~ → approved and published (v0.1.0).
5. Post-approval landing: bridge Origin whitelist trusting both channels (landed, `EXTENSION_ORIGINS` + §38); the Node side keeps the extension file / `manifest.key` precheck, and `sessionFlightSearch` / `sessionLogin` hand `installUrl` / `installAction` to the dsh UI on `needs-extension`; the old wizard no longer carries installation duty. The GitHub Releases channel (Track A) is kept as the review-free / versioned / rollback / mirror channel.

## Later releases (store channel)

- Store-build update: bump `version` in `extension/manifest.json` → the
  `extension-publish.yml` workflow packs automatically on `extension/**` pushes; the
  publish job (manual dispatch, `dry_run=false`, founder-confirm regime) uploads via
  the CWS REST API and submits for review — setup, response semantics and
  fail-closed rules in [extension-store-publish.md](../extension-store-publish.md).
  The devconsole manual upload remains the fallback; the repository's release
  discipline (AGENTS.md) and the store pull-back verification requirement are
  unchanged.
- GitHub channel update: the three-piece `ext-*` tag release assets (tar.gz / store-zip / dist-manifest), pulled by users via `npx @danceiny/gotry setup --extension-from=github`.

## How the three channels relate

| | Chrome Web Store (recommended) | GitHub Releases (no review) | In-npm copy (offline fallback) |
|---|---|---|---|
| One-click install | ✓ | ✗ (3 clicks in developer mode) | ✗ (same as left) |
| Auto-update | ✓ (with store releases) | ✗ (`--extension-from=github` pulls new versions manually) | ✗ (with npm releases) |
| Review cost | Registration + review | None | None |
| Versioning / rollback / mirror | ✗ (store cadence) | ✓ (Release assets + SHA256) | ✗ |
| Extension ID | `oeajpiccmonococjcegddlooeeohlbgd` | `olpgkofjhhiiiahdkkbcninhjmegghfe` | `olpgkofjhhiiiahdkkbcninhjmegghfe` |

## Pending Stai submission (candidate 0.2.0.26)

- The live store still serves 0.1.0 as GoTry Session Bridge. The 0.2.0.25 GitHub Release predates the Stai rename while current main still uses that version; a new version is needed for distinct bytes. Candidate 0.2.0.26 is preparation, not an authorized or submitted release.
- Include the Dida/HotelByte permissions, portal join and login behavior in the dashboard listing and privacy answers. Record the exact built SHA and zip checksum. The repository Actions workflow currently has no configured CWS secrets; use the dashboard upload only after the founder confirms the exact version and window, or configure the workflow's secrets through the account owner.
- **The store submission is tracked by [#346](https://github.com/Danceiny/gotry/issues/346)**; **founder decides whether / when / which version to bump** (founder-confirm regime, see `tech-strategy.md` §11 and the release discipline in `AGENTS.md`); **packaging / devconsole upload / status tracking / verification** are executed by the release executor under the repository release discipline; founder only completes the account-side personal approval / 2FA as required. Before the store build lands, store users calling dida get needs-extension (same as any brand-new site); the existing ctrip/12306 lanes are unaffected.
- unpacked / GitHub Releases channels are unaffected by store review; merging the `feat/session-dida-portal` branch takes effect immediately (PR #297 is merged; code and manifest are already in place).
- **Current evidence boundary**: there is no dashboard receipt of this submission or store pull-back verification. Upload, review acceptance and live publication remain separate states, tracked by [#346](https://github.com/Danceiny/gotry/issues/346) and [#537](https://github.com/Danceiny/gotry/issues/537).
