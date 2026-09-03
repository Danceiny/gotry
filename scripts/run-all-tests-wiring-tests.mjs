#!/usr/bin/env node
/**
 * Deterministic guard for the full-suite harness wiring.
 *
 * The generated dist tree is a prerequisite for both publish-preverify and
 * the headless planner E2E.  The TS runner must also be discoverable by child
 * processes (the receipt-ledger proof intentionally spawns it).
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = join(import.meta.dirname, '..')
const script = readFileSync(join(root, 'scripts', 'run-all-tests.sh'), 'utf8')
const executableLines = script.split('\n').map((line) => line.trim()).filter((line) => line && !line.startsWith('#'))

const build = script.indexOf('(node scripts/build-dist.mjs) || FAIL=1')
assert.notEqual(build, -1, 'run-all must build dist')
const preverify = script.indexOf('scripts/publish-preverify.ts')
const plannerE2E = script.indexOf('scripts/agent-planning-turn-deadline-e2e.ts')
assert.ok(build < preverify, 'dist build must precede publish preverify')
assert.ok(build < plannerE2E, 'dist build must precede planner E2E')

assert.match(script, /TSX_BIN=.*ts\/node_modules\/\.bin\/tsx/)
assert.match(script, /export PATH=.*\$TSX_BIN/)
assert.match(script, /-x "\$TSX_BIN"/)
assert.ok(
  executableLines.includes('("$TSX_BIN" scripts/booking-surface-package-proof.ts) || FAIL=1'),
  'the root package proof must use the installed tsx binary without an implicit npx fetch',
)
assert.ok(
  executableLines.includes('(cd ts && GOTRY_SESSION_LIVE="${GOTRY_SESSION_LIVE:-0}" npx tsx scripts/session-tests.ts) || FAIL=1'),
  'the active full-suite command must default optional live session probes off',
)
const forcedSessionFailure = spawnSync(
  process.execPath,
  [join(root, 'ts', 'node_modules', 'tsx', 'dist', 'cli.mjs'), join(root, 'ts', 'scripts', 'session-tests.ts')],
  {
    cwd: join(root, 'ts'),
    encoding: 'utf8',
    env: { ...process.env, GOTRY_SESSION_LIVE: '0', GOTRY_SESSION_TEST_FORCE_FAILURE: '1' },
  },
)
assert.notEqual(forcedSessionFailure.status, 0, 'a real session assertion failure must produce a non-zero process exit')
assert.match(forcedSessionFailure.stdout, /forced session failure propagation proof/)

console.log('RUN-ALL WIRING PROOF: dist-before-dependents/local-tsx-path/session-failure-propagation OK')
