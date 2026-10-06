/**
 * scripts/release-lib.mjs — the few helpers the release scripts share
 * (release-preflight.mjs, verify-published.mjs, post-release-docs.mjs, release-notes.mjs, release-oidc.mjs).
 * One copy, because two copies of a release rule drift apart (the #623 lesson).
 */

import { realpathSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

export const OFFICIAL_REGISTRY = 'https://registry.npmjs.org/'
/** Written by release-preflight.mjs --write-expected, right after the dist build and before the publish click. */
export const EXPECTED_FILE = '.release-expected.json'
/** Written by verify-published.mjs when the pull-back passes; post-release-docs.mjs reads it. */
export const VERIFIED_FILE = '.release-verified.json'

/**
 * Every job of .github/workflows/npm-publish.yml is named "Release: …". Their check runs sit on the tag commit while the
 * workflow runs and stay there, failed or not, after a rehearsal — they are not CI evidence for the tree, so the CI
 * proof in release-preflight.mjs skips them. npm-publish-workflow-tests.mjs pins the workflow's job names to this.
 */
export const RELEASE_CHECK_PREFIX = 'Release: '

export class UsageError extends Error {}

/**
 * True when `metaUrl` (a module's import.meta.url) is the script node was started with. Node reports the real path
 * in import.meta.url but keeps argv[1] as typed, so a plain comparison silently never runs main() when the script is
 * reached through a symlinked directory (macOS /tmp and /var are symlinks).
 */
export function isMain(metaUrl) {
  try { return metaUrl === pathToFileURL(realpathSync(process.argv[1])).href } catch { return false }
}

/** Never let a login token reach a log, a terminal or a JSON receipt. */
export function redact(text) {
  return String(text).replace(/token=[\w-]+/g, 'token=<redacted>')
}

/** An npm token (npm_ + base62) or a JWT. A log that holds one is withheld, not printed: Actions logs of a public repo are public. */
const SECRET_SHAPES = [/\bnpm_[A-Za-z0-9]{30,}/, /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/]
export function looksLikeSecret(text) {
  return SECRET_SHAPES.some((re) => re.test(String(text)))
}

const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/

export function parseSemver(version) {
  const m = SEMVER.exec(version)
  if (!m) return null
  return { core: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ? m[4].split('.') : [] }
}

/** semver precedence: -1 when a < b, 0 when equal, 1 when a > b; null when either side is not a version. */
export function compareSemver(a, b) {
  const x = parseSemver(a)
  const y = parseSemver(b)
  if (!x || !y) return null
  for (let i = 0; i < 3; i++) if (x.core[i] !== y.core[i]) return x.core[i] < y.core[i] ? -1 : 1
  if (!x.pre.length || !y.pre.length) return x.pre.length === y.pre.length ? 0 : x.pre.length ? -1 : 1
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i]
    const q = y.pre[i]
    if (p === undefined) return -1
    if (q === undefined) return 1
    if (p === q) continue
    const pn = /^\d+$/.test(p)
    const qn = /^\d+$/.test(q)
    if (pn && qn) return Number(p) < Number(q) ? -1 : 1
    if (pn !== qn) return pn ? -1 : 1
    return p < q ? -1 : 1
  }
  return 0
}

export function packumentUrl(registry, name) {
  return `${registry.endsWith('/') ? registry : `${registry}/`}${name.replace('/', '%2f')}`
}

/** The abbreviated packument (versions, dist-tags, dist facts) without any authentication. `null` = the package does not exist. */
export async function fetchPackument(registry, name) {
  const res = await fetch(packumentUrl(registry, name), {
    headers: { accept: 'application/vnd.npm.install-v1+json', 'cache-control': 'no-cache' },
    signal: AbortSignal.timeout(20_000),
  })
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`registry answered ${res.status}`)
  return res.json()
}
