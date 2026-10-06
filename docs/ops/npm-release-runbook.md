[English](npm-release-runbook.md) | [简体中文](npm-release-runbook.zh-CN.md)

# npm Release Runbook

> Position: the end-to-end procedure for publishing `@danceiny/gotry` to npm — who clicks what, what the execution agent runs, and what proves a release is real.
> Status: living
> Upstream: [AGENTS.md](../../AGENTS.md) release discipline (founder confirmation, release gate, pull-back rule), [tokens.md](../tokens.md) (credential paths and the npm 2FA facts)
> Downstream: `scripts/publish-npm.sh`, `scripts/release-preflight.mjs`, `scripts/verify-published.mjs`, `scripts/post-release-docs.mjs`, `scripts/release-notes.mjs`, `.github/workflows/npm-publish.yml`, `scripts/release-oidc.mjs`
> Last updated: 2026-10-06
> Boundary: this document owns the procedure; credential acquisition and the npm policy facts stay in tokens.md, and what counts as the release gate stays in AGENTS.md. No document may say "published" before the pull-back receipt in §4 exists.

## At a glance

- A release is one command run from a clean checkout of the release tag: `TAG=latest ./scripts/publish-npm.sh`.
- Everything knowable before the first click is checked first, in one pass, with every problem listed together.
- The founder's part is browser approvals only: one for the web login, one for the publish, one more per dist-tag write.
- Each approval link expires after about seven minutes, so the founder must be at the browser before the command starts.
- Nothing is "published" until `scripts/verify-published.mjs` passes: the registry serves the exact bytes built here, and a clean-room install runs.
- The GitHub Release is created only after that pull-back, and the web session is revoked at the very end.
- A stopped run loses nothing: re-running is safe, because the changelog gate is idempotent, an already-published version is detected, and the pull-back can run on its own.
- Once the founder has set up npm Trusted Publishing, the same release can run with no clicks as a GitHub Actions workflow (§7). Until its first real run has passed, the command above stays the path of record.

## 1. Before the first command

1. The founder has confirmed whether to release and which version (AGENTS.md).
2. The version-bump PR is merged. It carries the package version, lockfile, extension manifest, both release-notes files, and the generated `CHANGELOG.md` section.
3. The merged commit is tagged and pushed: `git tag v<version> <commit> && git push origin v<version>`.
4. A publish tree exists: a detached worktree at the tag with its own physical root `node_modules`.

```sh
git worktree add --detach /tmp/gotry-release v<version>
cd /tmp/gotry-release
npm ci --no-audit --no-fund --strict-peer-deps
# or clone a ready install (APFS; on Linux use cp -a --reflink=auto):
cp -cR <other-tree>/node_modules ./node_modules
```

The build refuses a symlinked or hoisted `node_modules` on purpose, because the dist bytes must come from this tree's own TypeScript. Only the root install is needed; `ts/node_modules` serves the regression suite, not the release.

## 2. Run it

```sh
TAG=latest ./scripts/publish-npm.sh
```

The dist-tag is always explicit (#50①). The stages run in this order and the first failure stops the run:

| Stage | What it does | Stops when |
|---|---|---|
| preflight | `release-preflight.mjs` checks version, tag, clean tree, docs, CI proof and registry | the tag is not on the remote at HEAD or not on `main`; a tracked file is modified; a release doc lacks the version; the tag commit has no green CI; the version is already published; the dist-tag would move backwards |
| changelog gate | the `CHANGELOG.md` top section carries the version; nothing else is uncommitted | the section is missing or the tree is dirty |
| build | `build-dist.mjs`, then the shasum and file count that `npm pack` predicts are recorded in `.release-expected.json` | the compiler guard refuses (§5) |
| presence | asks whether the founder is at the browser; `--yes` answers it | a non-interactive terminal without `--yes` |
| login | web login when there is no valid session — click 1 | the link expired |
| publish | `npm publish --tag $TAG` — click 2 | the link expired (§5) |
| pull-back | `verify-published.mjs`: registry visibility, tarball bytes against the prediction, then a clean-room `doctor`, plugin load, `web` boot and one-shot run | anything differs; no Release is created |
| GitHub Release | `gh release create` from `release-notes.mjs` | never fatal; the script prints the manual command |
| session | `npm logout` for a web session, then delete `.npmrc.publish` | never fatal |

The CI proof is the tag commit's own check runs, or the merged PR head with an identical tree when push CI was cancelled by concurrency. The registry usually needs about four minutes after the publish click before the pull-back sees the version (rc.28), and the pull-back polls for up to ten.

## 3. Driving it from an agent session

- Run the command in the Terminal panel, which is a real PTY. Without a TTY, `npm login --auth-type=web` falls into a `Username:` prompt.
- Ask the founder in chat whether they can click right now, before starting. An unclicked link is the commonest failed attempt: rc.27 lost two to it and rc.28 one.
- Start the command with `--yes` once the founder says yes, because the presence prompt cannot be answered from the agent side.
- Read the panel and paste each approval link into the chat the moment it appears. The login link comes first; the publish link comes after the founder's first click.
- A founder running the command in their own terminal has nothing extra to do: Enter at the prompt, then the two clicks.

## 4. After it passes

The script ends by naming the receipt `.release-verified.json`. In the main checkout, on a clean tree and a fresh branch:

```sh
node scripts/post-release-docs.mjs --receipt <publish-tree>/.release-verified.json
node scripts/check-docs-i18n.mjs && node scripts/check-doc-readability.mjs
```

The script adds a "Published" section to both release-notes files, and for a release on `latest` also rewrites the version baselines in README, user-guide and roadmap. Every pair is edited together or not at all, a second run changes nothing, and `--check` reports pending work without writing. The "Published" sentence names the route the receipt records in `publishedBy`: the click path unless the receipt says the workflow published it, in which case it links that run. A receipt written before the field existed cannot say so (the rc.29 tag's own workflow is one); pass `--published-by workflow --run-url https://github.com/<owner>/<repo>/actions/runs/<id>` to say it, and the flags win over the receipt. Commit the changed files (eight for a release on `latest`), open a docs PR, then remove the publish tree with `git worktree remove --force <publish-tree>`.

## 5. When it stops

| Symptom | Meaning | Do |
|---|---|---|
| a preflight list ending in `!! 预检未过` | the preflight found problems and listed them all | fix each one; do not skip it |
| npm `E404` on `/-/v1/done?authId=…` | the approval link expired or was never clicked; nothing was published | confirm the founder is at the browser, then rerun; a still-valid login session means only the publish click repeats |
| `cannot publish over the previously published versions` | the version is already on the registry because an earlier run died after the publish | run `node scripts/verify-published.mjs --tag <tag>`; never republish |
| `TypeScript must resolve within root node_modules` | the `node_modules` is symlinked or hoisted | `npm ci`, or clone an install (§1) |
| the pull-back says the version is not visible yet | registry propagation is slower than the ten-minute poll | rerun `verify-published.mjs --tag <tag> --wait 900` |
| the pull-back reports a shasum mismatch | the registry's bytes differ from this tree's build | stop; create no Release and write no "published" until the cause is found |
| no green CI proof for the tag commit | push CI was cancelled and no merged PR head has the same tree | for a tag that carries the `workflow_dispatch` trigger, run `gh workflow run CI --ref <tag>`; otherwise pass the PR-head evidence as `SKIP_CI_PROOF="<reason>"` |
| the dist-tag would move backwards | an older version is being published to a tag that is ahead | confirm the intent, then set `ALLOW_DOWNGRADE=1` |
| `gh release create` failed | the package is already verified; only the Release is missing | run the manual command the script prints |

Three emergency switches exist, and each leaves its claim unproven: `--skip-preflight`, `--skip-changelog`, and `--no-verify`. After `--no-verify` the script creates no Release and keeps the session, and nothing may say "published" until `verify-published.mjs` has passed.

## 6. dist-tags and sessions

- Repointing a dist-tag works with the `.env` granular token. Deleting one needs a web session: `./scripts/publish-npm.sh rmtag <tag>…`, one approval per tag, with `latest` refused. The facts and their history live in [tokens.md](../tokens.md).
- The session is revoked after a successful release. `--keep-session` keeps it for a maintenance batch, and `./scripts/publish-npm.sh logout` ends it.
- A `.npmrc.publish` token equal to `NPM_TOKEN` in `.env` is never revoked, because that is a long-lived token; the file is just deleted.
- Trusted Publishing from GitHub Actions replaces the clicks once it is set up and proven (§7, tokens.md Path C). Until its first real run has passed, §2 is the path of record.

## 7. Zero-click path: the publish workflow

`.github/workflows/npm-publish.yml` runs the stages of §2 on GitHub's runners and publishes with npm Trusted Publishing: the publish job's OIDC identity replaces the founder's two approvals, and no npm credential exists anywhere. It is built and has a structure lint (`scripts/npm-publish-workflow-tests.mjs`), but its first real use is still ahead.

**One-time setting.** The founder makes it, because it is persistent configuration:

1. npmjs.com → `@danceiny/gotry` → Settings → Trusted publishing → GitHub Actions. Organization or user `Danceiny`, Repository `gotry`, Workflow filename `npm-publish.yml`, Environment `npm-publish` (optional), Allowed actions: tick `npm publish`.
2. Optionally, GitHub → Settings → Environments → `npm-publish`: restrict deployment tags to `v*` and add required reviewers.

**Run it on the release tag.** `workflow_dispatch` runs the workflow file as it is at that tag, so the tag must already contain the file; the first release that can use it is the one cut after the PR that adds it.

```sh
gh workflow run npm-publish.yml --ref v<version> -f dist_tag=latest                    # rehearsal, the default
gh workflow run npm-publish.yml --ref v<version> -f dist_tag=latest -f dry_run=false   # the real publish
```

| Job | What it does | Identity |
|---|---|---|
| gate | refuses anything but a tag; runs the §2 preflight; installs the root dependencies without install scripts; builds; packs the tarball and records it in `.release-expected.json`; uploads both with the two OIDC tools | none |
| publish | checks the tarball against the recorded shasum; prints the run's OIDC claims beside the Trusted Publisher form values; runs `npm publish <tarball> --tag <dist_tag>` | `id-token: write`, environment `npm-publish` |
| verify | skipped on a rehearsal; runs `verify-published.mjs` against the registry and uploads the receipt | none |
| github-release | creates the GitHub Release from `release-notes.mjs` with `--verify-tag` | `contents: write` |

A rehearsal does everything except the registry write, including the real token exchange, because npm exchanges the token before it looks at `--dry-run`. A green rehearsal therefore proves the npm-side setting. It does not prove the allowed-actions tick or provenance; only the first real run exercises those. npm reports an OIDC failure only at verbose level and shows a generic "not logged in" otherwise, so `release-oidc.mjs` reads the verdict out of the log and prints it with a hint:

| Hint in the publish job | Meaning | Do |
|---|---|---|
| the exchange failed, with the registry's own reason above it | the Trusted Publisher setting does not match this run | compare the form with the claims block of the "OIDC claims" step: owner, repository, workflow filename and environment, case-sensitive |
| npm never attempted the exchange | the job lacks `id-token: write`, or the runner is not GitHub-hosted | restore the permission; self-hosted runners cannot publish this way |
| the exchange worked but the registry refused the write | the allowed actions lack `npm publish` | tick it on npmjs.com |
| the provenance statement was rejected | `repository.url` in package.json does not name this repository, or it is not public | fix it, or publish through §2, which carries no provenance |

What stays the same: the preflight, the pull-back rule, and the docs follow-up. After a real run, fetch the receipt with `gh run download <run-id> -n release-receipt -D <dir>` and continue at §4 with `--receipt <dir>/.release-verified.json`; the verify job records the route and its run URL in that receipt, so the docs say the workflow published it. What differs: the preflight's CI proof skips the workflow's own `Release: …` check runs; the job that holds the identity never runs anything installed after the checkout; and there is no approval link to expire. A failed run before the publish step published nothing. A failed verify step can be re-run on its own with "Re-run failed jobs", which reuses the gate's tarball and does not publish again.
