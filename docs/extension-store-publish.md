# Chrome Web Store Publish Setup

One-time setup that wires `.github/workflows/extension-publish.yml` to publish the
GoTry Session Bridge extension to the Chrome Web Store (distribution channel B,
ADR-21; incident follow-up to hotel-fe#3802 where the store was stuck on 0.1.0
because publishing was fully manual).

## 1. Background

The workflow packs `extension/` with `scripts/package-extension.mjs` and, only on
manual dispatch with `dry_run=false`, uploads the store zip through the Chrome Web
Store API. Publishing requires four repo secrets; everything else is already in the
workflow. CWS requires strictly increasing versions — the store currently holds 0.1.0,
so manifest `version` must stay above it.

The publish path is verifiable end to end (2026-09-25, #346/#537): the publish job
downloads the pack artifact explicitly into `dist-extension/` and asserts the three
files, the version and the SHA256 checksums against `extension-dist-manifest.json`
before any OAuth/network call (`scripts/cws-publish-validate.mjs artifact`). Every
API response is then classified against the documented v1.1 semantics — HTTP 2xx
alone is never treated as success. Uploading, review submission and store
availability are three distinct states; acceptance of a submission is not store
publication (§5).

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

Add four secrets under repo Settings → Secrets and variables → Actions (the direct
REST API needs no publisher ID; the earlier five-secret table belonged to the
retired third-party action era and is obsolete):

| Secret | Value |
| --- | --- |
| `CHROME_EXTENSION_ID` | `oeajpiccmonococjcegddlooeeohlbgd` |
| `CHROME_CLIENT_ID` | OAuth client ID from 2b |
| `CHROME_CLIENT_SECRET` | OAuth client secret from 2b |
| `CHROME_REFRESH_TOKEN` | refresh token from 2c |

## 4. First publish

Dispatch the workflow once with `dry_run=true` (pack only, verifies the version
guard and artifacts), then with `dry_run=false` after founder confirmation. The
publish job runs in order: artifact preflight → token → upload → publish; each step
fails closed per §5. CWS review takes hours to days; a store pull-back verification
(the listing actually shows the new version) is mandatory before anything may claim
published.

## 5. Publish response semantics (v1.1)

`scripts/cws-publish-validate.mjs` classifies each response; the classification is
fail-closed and its failure output carries only fixed reasons, HTTP codes and
derived booleans/counts — never response bodies, error descriptions or tokens
(no API-supplied text enters the workflow log; the access token's only output is
the masked `--field access_token` extraction).

| Step | Accepted (exit 0) | Rejected (exit 1) |
| --- | --- | --- |
| token | JSON body with a non-empty whitespace-free `access_token` | non-2xx; `error` field of any type (e.g. `invalid_grant`); missing/empty/whitespace-containing token; malformed JSON |
| upload | `uploadState: "SUCCESS"` with empty `itemError` | `FAILURE`/`IN_PROGRESS`/`NOT_FOUND`/unknown values; `SUCCESS` with a non-empty or malformed `itemError` (does not advance); non-2xx; malformed JSON |
| publish | `status[]` non-empty and **every** element is `OK` (classified `submitted` = this dispatch was accepted) | mixed `OK` + rejection, non-string elements, `NOT_AUTHORIZED`, `ITEM_NOT_FOUND`, `ITEM_TAKEN_DOWN`, unknown values, missing `status[]`; `ITEM_PENDING_REVIEW` alone is a distinct rejection (see below) |

- `ITEM_PENDING_REVIEW` means a previous submission may already be in review. It is
  not proof that this version was submitted: the step exits non-zero with a
  read-back instruction and must not be retried blindly. Read the item state from
  the CWS dashboard/API first; record an existing manual submission and avoid
  resubmission.
- Transport failures (curl timeout/connection error) mark the outcome UNCONFIRMED
  for that step — read back the item state before any retry; the workflow never
  retries automatically (a blind resubmit can duplicate a review).
- The publish request uses the documented v1 query parameter
  `publishTarget=default` (v1 has no `publishMode`).

## 6. Rollback

The [CWS dashboard rollback](https://developer.chrome.com/docs/webstore/rollback)
restores the previous published package under a new version number without another
review; pending and staged submissions are discarded. Test compatibility locally,
then obtain founder confirmation for the rollback action and exact new version
before triggering it. Verify the resulting version in the dashboard and store
listing before claiming success. A forward fix with a higher version remains an
alternative.

Retain the approved prior upload and its checksum as rollback evidence. A package
rebuilt from an `ext-*` repository tag is only a reconstruction until its equivalence
to the approved upload is verified.

## 7. Maintenance

Refresh tokens can expire or be revoked. If the token step reports an API error,
verify the credential state and re-mint the token using §2 when needed. Rotate the client secret by repeating 2b/2c/3 if
it leaks; the CWS item and extension ID are unaffected.

The workflow uses the documented [v1.1 API](https://developer.chrome.com/docs/webstore/api/v1). Any later API migration must update the workflow endpoints and the response classifier together.
