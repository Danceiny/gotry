# Chrome Web Store Publish Setup

One-time setup that wires `.github/workflows/extension-publish.yml` to publish the
GoTry Session Bridge extension to the Chrome Web Store (distribution channel B,
ADR-21; incident follow-up to hotel-fe#3802 where the store was stuck on 0.1.0
because publishing was fully manual).

## 1. Background

The workflow packs `extension/` with `scripts/package-extension.mjs` and, only on
manual dispatch with `dry_run=false`, uploads the store zip through the Chrome Web
Store API. Publishing requires five repo secrets; everything else is already in the
workflow. CWS requires strictly increasing versions — the store currently holds 0.1.0,
so manifest `version` must stay above it.

## 2. One-time OAuth setup

Done once by the founder with the Google account that owns the CWS item
(`danceiny@gmail.com`). The Chrome Web Store API uses Google Cloud OAuth2 client
credentials, not service accounts.

### 2a. GCP project & API

Create (or reuse) a project at https://console.cloud.google.com/ with the same
Google account, then enable the Chrome Web Store API under APIs & Services → Library.

### 2b. OAuth client

Under APIs & Services → Credentials → Create credentials → OAuth client ID, choose
application type **Desktop app**. Record the client ID and client secret.

### 2c. Refresh token

Authorize the scope `https://www.googleapis.com/auth/chromewebstore` with
`access_type=offline&prompt=consent` and exchange the code for a refresh token.
Google has retired the `urn:ietf:wg:oauth:2.0:oob` redirect — use a loopback
redirect (`http://localhost:PORT`) or https://developers.google.com/oauthplayground
(Appendix → use your own credentials). Store the refresh token like a password.

## 3. Repo secrets

Add five secrets under repo Settings → Secrets and variables → Actions:

| Secret | Value |
| --- | --- |
| `CHROME_EXTENSION_ID` | `oeajpiccmonococjcegddlooeeohlbgd` |
| `CHROME_PUBLISHER_ID` | publisher ID from CWS dashboard → Account |
| `CHROME_CLIENT_ID` | OAuth client ID from 2b |
| `CHROME_CLIENT_SECRET` | OAuth client secret from 2b |
| `CHROME_REFRESH_TOKEN` | refresh token from 2c |

## 4. First publish

Dispatch the workflow once with `dry_run=true` (pack only, verifies the version
guard and artifacts), then with `dry_run=false` after founder confirmation. CWS
review takes hours to days; verify the listing version before claiming published.

## 5. Maintenance

Refresh tokens expire after six months of inactivity — dispatch a publish at least
twice a year or re-mint the token. Rotate the client secret by repeating 2b/2c/3 if
it leaks; the CWS item and extension ID are unaffected.
