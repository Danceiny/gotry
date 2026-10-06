#!/usr/bin/env node
/**
 * scripts/release-oidc.mjs — the two OIDC-side steps of .github/workflows/npm-publish.yml.
 *
 *   claims    Ask GitHub for the id-token npm would receive (audience npm:registry.npmjs.org) and print the claims npm
 *             matches against the package's Trusted Publisher setting, plus the setting values that match this run, so
 *             the one-time npmjs.com form is copied rather than typed. The token itself is never printed. Fails when
 *             this job cannot be a trusted publisher at all: no id-token permission, not a GitHub-hosted runner,
 *             not dispatched on a tag.
 *   publish   `npm publish <tarball> --tag <dist-tag> --access public --loglevel verbose [--dry-run]` with npm's output
 *             captured, checked for token-shaped strings (Actions logs of a public repo are public) and then printed
 *             together with what it means. npm swallows every OIDC failure — the exchange error exists only at verbose
 *             level and the visible symptom is a generic "not logged in" — so the exchange's own verdict is read out of
 *             the log. A dry run still performs the exchange (npm exchanges before it looks at --dry-run), which is what
 *             lets a rehearsal prove the npm-side setting without publishing anything.
 *
 * Only release-lib.mjs is imported: the workflow copies both files into the release bundle, so the job that holds
 * `id-token: write` runs nothing that was installed after the checkout.
 *
 * Usage:
 *   node release-oidc.mjs claims [--audience npm:registry.npmjs.org]
 *   node release-oidc.mjs publish --tarball <file> --tag <dist-tag> [--dry-run] [--registry <url>]
 * Exit: 0 ok; 1 the check or the publish failed; 2 usage.
 */
import { spawnSync } from 'node:child_process'
import { appendFileSync, existsSync } from 'node:fs'
import { UsageError, isMain, looksLikeSecret } from './release-lib.mjs'

export const NPM_AUDIENCE = 'npm:registry.npmjs.org'

/** What the Trusted Publisher match can read, and nothing else: the token carries more (jti, actor, …) that never needs a log. */
const SHOWN_CLAIMS = [
  'repository', 'repository_owner', 'repository_visibility', 'job_workflow_ref', 'workflow_ref', 'environment',
  'ref', 'ref_type', 'sha', 'event_name', 'runner_environment', 'run_id', 'run_attempt',
]

export function decodeClaims(jwt) {
  const parts = String(jwt).split('.')
  if (parts.length !== 3) throw new Error('the id-token is not a JWT')
  try {
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'))
  } catch {
    throw new Error('the id-token payload is not JSON')
  }
}

/** The id-token GitHub would hand npm. Throws, in words, when the job has no `permissions: id-token: write`. */
export async function fetchIdToken({ env = process.env, fetchImpl = fetch, audience = NPM_AUDIENCE } = {}) {
  const base = env.ACTIONS_ID_TOKEN_REQUEST_URL
  const bearer = env.ACTIONS_ID_TOKEN_REQUEST_TOKEN
  if (!base || !bearer) {
    throw new Error('no id-token request variables: this job lacks `permissions: id-token: write`, or it is not running on GitHub Actions')
  }
  const url = new URL(base)
  url.searchParams.set('audience', audience)
  const res = await fetchImpl(url, { headers: { accept: 'application/json', authorization: `Bearer ${bearer}` }, signal: AbortSignal.timeout(20_000) })
  if (!res.ok) throw new Error(`GitHub answered ${res.status} to the id-token request`)
  const body = await res.json()
  if (!body?.value) throw new Error('GitHub answered the id-token request without a token')
  return body.value
}

/**
 * The npmjs.com "Trusted publisher" form values that match this run. The workflow filename comes from the job's workflow
 * ref ("owner/repo/.github/workflows/<file>@<ref>"): npm compares the file name, extension included, case-sensitively.
 */
export function trustedPublisherSettings(claims) {
  const ref = String(claims.job_workflow_ref || claims.workflow_ref || '')
  const m = /^([^/]+)\/([^/]+)\/\.github\/workflows\/([^@]+)@/.exec(ref)
  return {
    owner: m?.[1] ?? String(claims.repository_owner ?? ''),
    repository: m?.[2] ?? String(claims.repository ?? '').split('/')[1] ?? '',
    workflow: m?.[3] ?? '',
    environment: String(claims.environment ?? ''),
  }
}

/** What would stop npm from accepting this job as a trusted publisher no matter how the npmjs.com form is filled in. */
export function judgeClaims(claims, { requireTag = true } = {}) {
  const problems = []
  if (claims.runner_environment !== 'github-hosted') problems.push(`npm Trusted Publishing accepts GitHub-hosted runners only; this one is "${claims.runner_environment ?? 'unknown'}"`)
  if (requireTag && claims.ref_type !== 'tag') problems.push(`dispatched on ${claims.ref_type ?? 'an unknown ref type'} "${claims.ref ?? ''}"; release only from a version tag (gh workflow run npm-publish.yml --ref v<version> …)`)
  if (!trustedPublisherSettings(claims).workflow) problems.push('the claims name no workflow file, so npm has nothing to match the workflow filename against')
  return problems
}

export function renderClaims(claims) {
  const width = Math.max(...SHOWN_CLAIMS.map((k) => k.length))
  const lines = ['OIDC claims in this run (what npm matches against the package\'s Trusted Publisher setting):']
  for (const key of SHOWN_CLAIMS) lines.push(`  ${key.padEnd(width)}  ${claims[key] === undefined ? '(absent)' : claims[key]}`)
  const s = trustedPublisherSettings(claims)
  lines.push(
    '',
    'npmjs.com → the package → Settings → Trusted publishing → GitHub Actions — the values that match this run:',
    `  Organization or user  ${s.owner}`,
    `  Repository            ${s.repository}`,
    `  Workflow filename     ${s.workflow}`,
    `  Environment           ${s.environment || '(none in this run)'}   (optional; when filled in it must equal the line above)`,
    '  Allowed actions       tick "npm publish" (the workflow publishes the tarball; "npm stage publish" alone is not enough)',
    `  Provenance            ${claims.repository_visibility === 'public' ? 'will be generated (public repository)' : `not generated (repository is ${claims.repository_visibility ?? 'of unknown visibility'})`}`,
  )
  return lines
}

export async function runClaims({ env = process.env, fetchImpl = fetch, log = console.log, audience = NPM_AUDIENCE } = {}) {
  let claims
  try {
    claims = decodeClaims(await fetchIdToken({ env, fetchImpl, audience }))
  } catch (err) {
    log(`::error::${err.message}`)
    return 1
  }
  for (const line of renderClaims(claims)) log(line)
  const problems = judgeClaims(claims)
  for (const p of problems) log(`::error::${p}`)
  return problems.length ? 1 : 0
}

/** What npm's verbose log says about the exchange and the publish, and what to do about it. */
export function classifyPublish({ status, output, dryRun }) {
  const exchanged = /oidc Successfully retrieved and set token/.test(output)
  const failures = [...output.matchAll(/oidc (Failed[^\n]*|Failure with message[^\n]*)/g)].map((m) => m[1].trim())
  const hints = []
  if (!exchanged) {
    if (failures.length) hints.push('npm could not exchange the GitHub id-token for a publish token — the line(s) above carry the registry\'s own reason. Check the Trusted Publisher form against the claims printed by the previous step: owner, repository, workflow filename and environment must match exactly (case-sensitive).')
    else hints.push('npm never attempted the OIDC exchange: the job lacks `permissions: id-token: write`, or the runner is not GitHub-hosted.')
  }
  if (/cannot publish over the previously published/i.test(output)) {
    hints.push('This version is already on the registry. Do not publish again: run `node scripts/verify-published.mjs --tag <dist-tag>` and finish from the pull-back (docs/ops/npm-release-runbook.md §5).')
  }
  if (exchanged && /\b(E403|E401|E404)\b|403 Forbidden|404 Not Found - PUT/.test(output)) {
    hints.push('The exchange worked but the registry refused the write: in the Trusted Publisher form tick "npm publish" under allowed actions, and make sure the package settings do not require something a workflow cannot give.')
  }
  if (/\bE422\b|Error verifying sigstore|Failed to validate repository information|Provenance generation/i.test(output) && status !== 0) {
    hints.push('The registry rejected the provenance statement: package.json "repository.url" must name this GitHub repository exactly (case-sensitive) and the repository must be public. The click path (scripts/publish-npm.sh) publishes without provenance.')
  }
  const published = status === 0 && !dryRun
  const ok = dryRun ? status === 0 && exchanged : status === 0
  return { ok, exchanged, published, failures, hints }
}

/**
 * npm reads an argument like "bundle/x.tgz" as a GitHub shorthand (user/repo) and tries to clone it over ssh — the
 * rc.29 rehearsal died on exactly that before the OIDC exchange began. Only a leading "./", "../" or "/" makes it a file.
 */
export function fileSpec(path) {
  return /^(?:\.{1,2}\/|\/)/.test(path) ? path : `./${path}`
}

export function runPublish({ tarball, tag, dryRun = false, registry = '', run = spawnSync, log = console.log, summaryFile = process.env.GITHUB_STEP_SUMMARY || '' }) {
  const args = ['publish', fileSpec(tarball), '--tag', tag, '--access', 'public', '--loglevel', 'verbose']
  if (dryRun) args.push('--dry-run')
  if (registry) args.push('--registry', registry)
  const r = run('npm', args, { encoding: 'utf8', maxBuffer: 64 << 20 })
  const output = `${r.stdout ?? ''}\n${r.stderr ?? ''}`.trim()
  if (looksLikeSecret(output)) {
    log('::error::npm\'s output contains a token-shaped string, so it is withheld (this log is public). Do not retry before finding out why.')
    return 1
  }
  log(output)
  const verdict = classifyPublish({ status: r.status ?? 1, output, dryRun })
  log('')
  if (verdict.ok && dryRun) log(`REHEARSAL OK: the OIDC exchange works for this workflow — nothing was published (${tarball}, dist-tag ${tag}).`)
  else if (verdict.ok) {
    log(`PUBLISHED through npm: ${tarball} under dist-tag ${tag}. This is not "published" yet — the registry pull-back (verify job) decides that.`)
    if (!verdict.exchanged) log('::warning::the publish succeeded without the OIDC exchange: some other credential was in play. Find out which before the next release.')
  } else {
    log(`::error::${dryRun ? 'the rehearsal did not prove the OIDC exchange' : 'npm publish failed'} (exit ${r.status ?? 'none'}); nothing was published unless npm said so above.`)
  }
  for (const h of verdict.hints) log(`::error::${h}`)
  if (summaryFile) {
    appendFileSync(summaryFile, `### npm publish (${dryRun ? 'rehearsal' : 'real'}) — ${verdict.ok ? 'OK' : 'FAILED'}\n\n- tarball \`${tarball}\`, dist-tag \`${tag}\`\n- OIDC exchange: ${verdict.exchanged ? 'worked' : 'did not happen or failed'}\n${verdict.failures.map((f) => `- npm: ${f}\n`).join('')}${verdict.hints.map((h) => `- ${h}\n`).join('')}`)
  }
  return verdict.ok ? 0 : 1
}

export function parseArgs(argv) {
  const [command, ...rest] = argv
  if (command !== 'claims' && command !== 'publish') throw new UsageError('the first argument is "claims" or "publish"')
  const opts = { command, audience: NPM_AUDIENCE, tarball: '', tag: '', dryRun: false, registry: '' }
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]
    const value = () => {
      const v = rest[++i]
      if (v === undefined || v.startsWith('--')) throw new UsageError(`${a} needs a value`)
      return v
    }
    if (a === '--audience') opts.audience = value()
    else if (a === '--tarball') opts.tarball = value()
    else if (a === '--tag') opts.tag = value()
    else if (a === '--registry') opts.registry = value()
    else if (a === '--dry-run') opts.dryRun = true
    else throw new UsageError(`unknown argument ${a}`)
  }
  if (command === 'publish') {
    if (!opts.tarball) throw new UsageError('--tarball is required')
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(opts.tag)) throw new UsageError('--tag is required and must be a plain dist-tag name (the tag is an explicit intent, #50①)')
  }
  return opts
}

async function main() {
  let opts
  try { opts = parseArgs(process.argv.slice(2)) } catch (err) {
    if (err instanceof UsageError) {
      console.error(`error: ${err.message}\nusage: node release-oidc.mjs claims [--audience <aud>]\n       node release-oidc.mjs publish --tarball <file> --tag <dist-tag> [--dry-run] [--registry <url>]`)
      return 2
    }
    throw err
  }
  if (opts.command === 'claims') return runClaims({ audience: opts.audience })
  if (!existsSync(opts.tarball)) { console.error(`error: ${opts.tarball} does not exist`); return 2 }
  return runPublish(opts)
}

if (isMain(import.meta.url)) {
  main().then((code) => process.exit(code), (err) => { console.error(err); process.exit(2) })
}
