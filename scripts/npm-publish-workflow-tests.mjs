#!/usr/bin/env node
/**
 * Lint for .github/workflows/npm-publish.yml — the workflow that holds the right to publish @danceiny/gotry.
 *
 * Nothing here can prove that npm accepts the OIDC exchange (only a real run can); what it can prove is that the
 * file keeps the shape its safety argument rests on. The argument: the job that holds `id-token: write` runs nothing
 * that was installed after the checkout, only a tarball and two tool files the (token-less) gate job staged; nothing in
 * the file is an npm secret; the registry is written only from a version tag, only on request, and a rehearsal is the
 * default. Each rule below is asserted twice: the real file passes, and a mutation that breaks exactly that rule is
 * caught — a lint that cannot fail is not a lint.
 *
 * YAML is read line by line (two-space indentation, no flow style but `{}`), because the repository has no YAML parser
 * to depend on and the file's shape is under this suite's control.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { RELEASE_CHECK_PREFIX, compareSemver } from './release-lib.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
export const WORKFLOW_PATH = '.github/workflows/npm-publish.yml'
/** npm Trusted Publishing needs npm >= 11.5.1. */
const MIN_NPM = '11.5.1'
const JOBS = ['gate', 'publish', 'verify', 'release']

/** Comment-only and blank lines dropped: the header explains the rules and must not trip them (it names the forbidden words). */
const significant = (text) => text.split('\n').filter((l) => l.trim() && !/^\s*#/.test(l))

/** The `key:` lines at exactly `indent` spaces, each with the lines that follow it (deeper, or up to the next sibling). */
function children(lines, indent) {
  const re = new RegExp(`^ {${indent}}([A-Za-z0-9_.-]+):[ \\t]*(.*)$`)
  const out = new Map()
  let current = null
  for (const line of lines) {
    const m = re.exec(line)
    if (m) {
      current = { value: m[2], body: [] }
      out.set(m[1], current)
    } else if (current) {
      current.body.push(line)
    }
  }
  return out
}

/** The steps of a job: each is the `- ` line at six spaces plus what follows, up to the next step. */
function stepsOf(job) {
  const steps = []
  for (const line of children(job.body, 4).get('steps')?.body ?? []) {
    if (/^ {6}- /.test(line)) steps.push([line])
    else steps.at(-1)?.push(line)
  }
  return steps
}

/** The script text of every `run:` in a step (block scalar or one-liner). */
function runBodies(stepLines) {
  const bodies = []
  stepLines.forEach((line, i) => {
    const m = /^(\s*)(- )?run:\s*(.*)$/.exec(line)
    if (!m) return
    const keyIndent = m[1].length + (m[2] ? 2 : 0)
    const body = m[3] && !/^[|>][+-]?$/.test(m[3]) ? [m[3]] : []
    for (let j = i + 1; j < stepLines.length && stepLines[j].search(/\S/) > keyIndent; j++) body.push(stepLines[j])
    bodies.push(body.join('\n'))
  })
  return bodies
}

const permissionsOf = (job) => {
  const block = children(job.body, 4).get('permissions')
  if (!block) return null
  const map = {}
  for (const [key, { value }] of children(block.body, 6)) map[key] = value.trim()
  return map
}

const needsOf = (job) => {
  const v = children(job.body, 4).get('needs')?.value.trim() ?? ''
  return v.startsWith('[') ? v.slice(1, -1).split(',').map((s) => s.trim()).filter(Boolean) : v ? [v] : []
}

export function lintWorkflow(text) {
  const lines = significant(text)
  const problems = []
  const need = (cond, msg) => { if (!cond) problems.push(msg) }

  // ---- no npm secret of any kind: the identity is the OIDC claim, nothing is stored ----
  for (const word of ['secrets.', 'NODE_AUTH_TOKEN', 'NPM_TOKEN', '_authToken', 'registry-url', 'always-auth']) {
    need(!lines.some((l) => l.includes(word)), `the workflow must not mention "${word}": publishing is by OIDC identity only, no stored credential and no .npmrc written by setup-node`)
  }

  const top = children(lines, 0)

  // ---- trigger: a person asks for it, nothing else starts it ----
  const triggers = [...children(top.get('on')?.body ?? [], 2).keys()]
  need(triggers.length === 1 && triggers[0] === 'workflow_dispatch', `on: must be exactly workflow_dispatch (found ${triggers.join(', ') || 'nothing'}): a publish is never started by an event`)
  const inputs = children(children(children(top.get('on')?.body ?? [], 2).get('workflow_dispatch')?.body ?? [], 4).get('inputs')?.body ?? [], 6)
  const input = (name) => children(inputs.get(name)?.body ?? [], 8)
  need(input('dist_tag').get('required')?.value.trim() === 'true' && !input('dist_tag').has('default'), 'dist_tag must be required and have no default: the dist-tag is an explicit intent (#50①)')
  need(input('dist_tag').get('type')?.value.trim() === 'choice', 'dist_tag must be a choice, so a typo cannot create a stray dist-tag')
  need(input('dry_run').get('type')?.value.trim() === 'boolean' && input('dry_run').get('default')?.value.trim() === 'true', 'dry_run must be a boolean that defaults to true: the safe run is the default one')
  need(input('allow_downgrade').get('default')?.value.trim() === 'false', 'allow_downgrade must default to false')

  need(top.get('permissions')?.value.trim() === '{}', 'top-level permissions must be {}: every job declares what it needs')
  need(top.get('concurrency')?.body.some((l) => /cancel-in-progress:\s*false/.test(l)), 'concurrency must not cancel a running release')

  // ---- jobs ----
  const jobs = children(top.get('jobs')?.body ?? [], 2)
  for (const id of JOBS) need(jobs.has(id), `job "${id}" is missing`)
  for (const id of jobs.keys()) need(JOBS.includes(id), `unexpected job "${id}": a new job changes the permission argument — extend this suite with it first`)
  const grants = (job, perm) => permissionsOf(job)?.[perm]
  for (const [id, job] of jobs) {
    const fields = children(job.body, 4)
    need(String(fields.get('name')?.value ?? '').replace(/^"|"$/g, '').startsWith(RELEASE_CHECK_PREFIX), `job ${id}: name must start with "${RELEASE_CHECK_PREFIX}" — the preflight CI proof skips check runs by that prefix, so a differently named job would count as CI`)
    need(permissionsOf(job) !== null, `job ${id}: needs its own permissions block (nothing is inherited)`)
    need(fields.has('timeout-minutes'), `job ${id}: needs a timeout`)
    need(/^ubuntu-\d/.test(fields.get('runs-on')?.value.trim() ?? ''), `job ${id}: runs-on must be a pinned GitHub-hosted ubuntu image (npm Trusted Publishing needs hosted runners)`)
    for (const [perm, value] of Object.entries(permissionsOf(job) ?? {})) {
      if (value === 'write') need((perm === 'id-token' && id === 'publish') || (perm === 'contents' && id === 'release'), `job ${id}: ${perm}: write is not allowed here (id-token only in publish, contents only in release)`)
    }
  }
  need(grants(jobs.get('publish') ?? { body: [] }, 'id-token') === 'write', 'job publish: must hold id-token: write — it is the OIDC identity')
  need(grants(jobs.get('release') ?? { body: [] }, 'contents') === 'write', 'job release: must hold contents: write to create the GitHub Release')

  // ---- every action pinned to a commit, first-party only ----
  for (const line of lines) {
    const m = /^\s*(?:- )?uses:\s*(\S+)(?:\s+#\s*(\S.*))?$/.exec(line)
    if (!m) continue
    need(/^actions\/[a-z-]+@[0-9a-f]{40}$/.test(m[1]), `${m[1]}: actions must be actions/* pinned to a full 40-hex commit SHA (a moved tag must not be able to run with the OIDC identity)`)
    need(Boolean(m[2] && /^v\d/.test(m[2])), `${m[1]}: keep the version in a trailing "# v…" comment, so the pin can be reviewed`)
  }

  // ---- nothing user-controlled is pasted into a shell script: values reach scripts through env ----
  for (const [id, job] of jobs) {
    for (const step of stepsOf(job)) {
      for (const body of runBodies(step)) need(!body.includes('${{'), `job ${id}: a run script interpolates \${{ }} directly; pass it through env instead\n${body.split('\n').find((l) => l.includes('${{'))}`)
    }
  }

  const text_of = (id) => (jobs.get(id)?.body ?? []).join('\n')

  // ---- gate: no identity; the only job that installs and builds ----
  const gate = text_of('gate')
  need(grants(jobs.get('gate') ?? { body: [] }, 'id-token') === undefined, 'job gate: must not have id-token — it installs dependencies, and an install script must not be able to mint the publish identity')
  need(/GITHUB_REF_TYPE/.test(gate) && /!=\s*"tag"/.test(gate), 'job gate: must refuse a dispatch that is not on a tag')
  need(/release-preflight\.mjs\s+"\$\{args\[@\]\}"/.test(gate), 'job gate: must run the preflight')
  need(/npm ci [^\n]*--ignore-scripts/.test(gate), 'job gate: npm ci must run with --ignore-scripts')
  need(/--write-expected[^\n]*--pack-dir/.test(gate), 'job gate: must pack the real tarball and record it with --write-expected --pack-dir')
  need(/release-lib\.mjs[^\n]*release-oidc\.mjs/.test(gate), 'job gate: must stage release-lib.mjs and release-oidc.mjs into the bundle')
  need(/include-hidden-files:\s*true/.test(gate), 'job gate: the bundle holds .release-expected.json, which upload-artifact skips unless hidden files are included')

  // ---- publish: the identity, and almost nothing else ----
  const publish = text_of('publish')
  need(needsOf(jobs.get('publish') ?? { body: [] }).includes('gate'), 'job publish: must need gate')
  need(/environment:\s*npm-publish\b/.test(publish), 'job publish: must run in the npm-publish environment (the place for tag restriction and reviewers)')
  need(!/actions\/checkout/.test(publish), 'job publish: must not check out the repository — it publishes the gate\'s tarball with the gate\'s staged tools')
  need(!/\bnpm (ci|install|i)\b(?![^\n]*--global npm@)/.test(publish) && !/\b(pnpm|yarn|npx)\b/.test(publish), 'job publish: must install nothing but the pinned npm itself')
  const pin = /npm install --global npm@(\d+\.\d+\.\d+)\b/.exec(publish)
  need(Boolean(pin), 'job publish: must pin npm to an exact version (npm install --global npm@x.y.z)')
  need(!pin || (compareSemver(pin[1], MIN_NPM) ?? -1) >= 0, `job publish: npm must be >= ${MIN_NPM} for Trusted Publishing (pinned ${pin?.[1]})`)
  need(/bundle\/\.release-expected\.json/.test(publish) === false && /sha1sum -c/.test(publish), 'job publish: must check the downloaded tarball against the recorded shasum before publishing')
  need(/node bundle\/tools\/release-oidc\.mjs claims/.test(publish) && /node bundle\/tools\/release-oidc\.mjs publish/.test(publish), 'job publish: must run the bundled release-oidc.mjs claims, then publish')
  need(/DRY_RUN/.test(publish) && /--dry-run/.test(publish), 'job publish: must honour dry_run')

  // ---- verify and release: only after a real, successful publish ----
  const verify = jobs.get('verify') ?? { body: [] }
  need(/inputs\.dry_run/.test(children(verify.body, 4).get('if')?.value ?? ''), 'job verify: must be skipped on a rehearsal (if: inputs.dry_run is false)')
  need(needsOf(verify).includes('publish'), 'job verify: must need publish')
  need(/verify-published\.mjs[^\n]*--tag/.test(text_of('verify')), 'job verify: must run verify-published.mjs with the explicit dist-tag')
  const release = jobs.get('release') ?? { body: [] }
  need(needsOf(release).includes('verify'), 'job release: must need verify — the GitHub Release is created only after a passing pull-back')
  need(/release-notes\.mjs/.test(text_of('release')) && /--verify-tag/.test(text_of('release')), 'job release: must build the notes with release-notes.mjs and create the Release with --verify-tag (never --target)')
  return problems
}

// =========================================================================================================
const real = readFileSync(join(ROOT, WORKFLOW_PATH), 'utf8')
let checks = 0
const noProblems = lintWorkflow(real)
assert.deepEqual(noProblems, [], `the workflow must pass its own lint:\n${noProblems.join('\n')}`)
checks++

/**
 * The mutation must change the file where the lint looks — comments are invisible to it, and `replace` hits the first
 * occurrence, which can be the header prose — and must trip the expected rule.
 */
function mutate(name, from, to, expected) {
  assert.ok(real.includes(from), `mutation "${name}": the real file no longer contains ${JSON.stringify(from)} — update the mutation`)
  const mutated = real.replace(from, to)
  assert.notDeepEqual(significant(mutated), significant(real), `mutation "${name}" only touched a comment — anchor it on the code line`)
  const problems = lintWorkflow(mutated)
  assert.ok(problems.some((p) => expected.test(p)), `mutation "${name}" was not caught; lint said:\n${problems.join('\n') || '(nothing)'}`)
  checks++
}

mutate('a second trigger', 'on:\n  workflow_dispatch:', 'on:\n  push:\n    branches: [main]\n  workflow_dispatch:', /on: must be exactly workflow_dispatch/)
mutate('dist_tag gets a default', '        required: true\n        type: choice', '        required: true\n        default: latest\n        type: choice', /dist_tag must be required and have no default/)
mutate('dist_tag becomes free text', 'type: choice', 'type: string', /dist_tag must be a choice/)
mutate('dry_run defaults to false', '        default: true\n        type: boolean', '        default: false\n        type: boolean', /dry_run must be a boolean that defaults to true/)
mutate('allow_downgrade defaults to true', '        required: false\n        default: false\n        type: boolean', '        required: false\n        default: true\n        type: boolean', /allow_downgrade must default to false/)
mutate('top-level permissions are inherited', 'permissions: {}\n', 'permissions:\n  contents: read\n', /top-level permissions must be \{\}/)
mutate('a release can be cancelled mid-flight', 'cancel-in-progress: false', 'cancel-in-progress: true', /must not cancel a running release/)
mutate('the gate gets the OIDC identity', '      contents: read\n      checks: read', '      contents: read\n      id-token: write\n      checks: read', /gate: id-token: write is not allowed|gate: must not have id-token/)
mutate('publish also gets contents: write', '    environment: npm-publish\n    permissions:\n      contents: read', '    environment: npm-publish\n    permissions:\n      contents: write', /publish: contents: write is not allowed/)
mutate('publish loses the OIDC identity', '      contents: read\n      id-token: write', '      contents: read', /publish: must hold id-token: write/)
mutate('verify can write', '    timeout-minutes: 30\n    permissions:\n      contents: read\n    steps:\n      - name: Checkout the tag', '    timeout-minutes: 30\n    permissions:\n      contents: write\n    steps:\n      - name: Checkout the tag', /verify: contents: write is not allowed/)
mutate('a stored npm token appears', '          DIST_TAG: ${{ inputs.dist_tag }}\n          DRY_RUN', '          NODE_AUTH_TOKEN: ${{ github.token }}\n          DIST_TAG: ${{ inputs.dist_tag }}\n          DRY_RUN', /must not mention "NODE_AUTH_TOKEN"/)
mutate('a repository secret is referenced', 'GH_TOKEN: ${{ github.token }}\n          DIST_TAG', 'GH_TOKEN: ${{ secrets.GH_PAT }}\n          DIST_TAG', /must not mention "secrets\."/)
mutate('setup-node writes an .npmrc', 'node-version: 24\n\n      # Trusted Publishing', 'node-version: 24\n          registry-url: https://registry.npmjs.org\n\n      # Trusted Publishing', /must not mention "registry-url"/)
mutate('an action is pinned by tag', 'actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093 # v4.3.0', 'actions/download-artifact@v4 # v4.3.0', /40-hex commit SHA/)
mutate('a third-party action appears', 'actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02 # v4.6.2', 'someone/upload@ea165f8d65b6e75b540449e92b4886f43607fa02 # v4.6.2', /actions\/\* pinned/)
mutate('a pin loses its version comment', 'actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 # v4.4.0', 'actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020', /trailing "# v…" comment/)
mutate('a job loses the Release: prefix', 'name: "Release: publish"', 'name: "Publish to npm"', /name must start with "Release: "/)
mutate('a job loses its permissions block', '    timeout-minutes: 10\n    permissions:\n      contents: write', '    timeout-minutes: 10\n    permissions_removed:\n      contents: write', /needs its own permissions block/)
mutate('a job loses its timeout', '    timeout-minutes: 15\n', '', /publish: needs a timeout/)
mutate('a floating runner', 'runs-on: ubuntu-24.04\n    timeout-minutes: 15', 'runs-on: ubuntu-latest\n    timeout-minutes: 15', /pinned GitHub-hosted ubuntu image/)
mutate('a self-hosted runner', 'runs-on: ubuntu-24.04\n    timeout-minutes: 15', 'runs-on: self-hosted\n    timeout-minutes: 15', /pinned GitHub-hosted ubuntu image/)
mutate('an input is pasted into a script', 'if [ "$ALLOW_DOWNGRADE" = "true" ]', 'if [ "${{ inputs.allow_downgrade }}" = "true" ]', /interpolates \$\{\{ \}\} directly/)
mutate('the gate stops refusing branches', '"$GITHUB_REF_TYPE" != "tag"', '"$GITHUB_REF_TYPE" != "branch"', /refuse a dispatch that is not on a tag/)
mutate('the gate installs with scripts', 'npm ci --ignore-scripts', 'npm ci', /npm ci must run with --ignore-scripts/)
mutate('the gate stops packing the real tarball', '--tag "$DIST_TAG" --pack-dir', '--tag "$DIST_TAG" --no-pack-dir', /--write-expected --pack-dir/)
mutate('the gate forgets to stage the tools', 'cp scripts/release-lib.mjs scripts/release-oidc.mjs', 'cp scripts/release-lib.mjs scripts/verify-published.mjs', /stage release-lib\.mjs and release-oidc\.mjs/)
mutate('the publish job leaves the environment', 'environment: npm-publish', 'environment: other', /npm-publish environment/)
mutate('the publish job checks out the repository', '      - name: Download the release bundle\n        uses: actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093 # v4.3.0\n        with:\n          name: release-bundle\n          path: bundle\n\n      - name: Setup Node.js\n        uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 # v4.4.0\n        with:\n          node-version: 24\n\n      # Trusted', '      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4.4.0\n      - name: Download the release bundle\n        uses: actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093 # v4.3.0\n        with:\n          name: release-bundle\n          path: bundle\n\n      - name: Setup Node.js\n        uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 # v4.4.0\n        with:\n          node-version: 24\n\n      # Trusted', /must not check out the repository/)
mutate('the publish job installs repository dependencies', '          npm --version\n', '          npm --version\n          npm ci\n', /install nothing but the pinned npm/)
mutate('npm is not pinned', 'npm install --global npm@11.21.0', 'npm install --global npm@latest', /pin npm to an exact version/)
mutate('npm is pinned too low', 'npm install --global npm@11.21.0', 'npm install --global npm@10.9.0', /npm must be >= 11\.5\.1/)
mutate('the tarball is no longer checked', 'echo "$expected  $TARBALL" | sha1sum -c -', 'echo "$expected  $TARBALL"', /check the downloaded tarball/)
mutate('the rehearsal flag is dropped', 'if [ "$DRY_RUN" = "true" ]; then args+=(--dry-run); fi', 'true', /must honour dry_run/)
mutate('verify runs on a rehearsal too', 'if: ${{ !inputs.dry_run }}', 'if: ${{ always() }}', /skipped on a rehearsal/)
mutate('verify no longer needs publish', 'needs: [gate, publish]', 'needs: [gate]', /verify: must need publish/)
mutate('the Release is created before the pull-back', 'needs: [gate, verify]', 'needs: [gate, publish]', /created only after a passing pull-back/)
mutate('the Release uses --target', '--notes-file "$RUNNER_TEMP/notes.md" --verify-tag', '--notes-file "$RUNNER_TEMP/notes.md" --target "v$VERSION"', /--verify-tag/)

console.log(`NPM PUBLISH WORKFLOW TESTS: ${checks} checks OK`)
