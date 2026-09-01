#!/usr/bin/env node
/**
 * Deterministic guard for the full-suite harness wiring.
 *
 * The generated dist tree is a prerequisite for both publish-preverify and
 * the headless planner E2E.  The TS runner must also be discoverable by child
 * processes (the receipt-ledger proof intentionally spawns it).
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = join(import.meta.dirname, '..')
const script = readFileSync(join(root, 'scripts', 'run-all-tests.sh'), 'utf8')

const build = script.indexOf('(node scripts/build-dist.mjs) || FAIL=1')
assert.notEqual(build, -1, 'run-all must build dist')
const preverify = script.indexOf('scripts/publish-preverify.ts')
const plannerE2E = script.indexOf('scripts/agent-planning-budget-e2e.ts')
assert.ok(build < preverify, 'dist build must precede publish preverify')
assert.ok(build < plannerE2E, 'dist build must precede planner E2E')

assert.match(script, /TSX_BIN=.*ts\/node_modules\/\.bin\/tsx/)
assert.match(script, /export PATH=.*\$TSX_BIN/)
assert.match(script, /-x "\$TSX_BIN"/)

console.log('RUN-ALL WIRING PROOF: dist-before-dependents/local-tsx-path OK')
