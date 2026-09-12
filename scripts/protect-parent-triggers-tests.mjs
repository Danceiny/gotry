#!/usr/bin/env node
/**
 * Fixture tests for scripts/protect-parent-triggers.mjs (issue #417, post root-review).
 *
 * Each case asserts the actual checker exit status on the RAW GraphQL envelope
 * shape — the same shape the production workflow writes to disk. We do NOT trust
 * stdout; the contract is the exit code and the exit code alone.
 *
 * Cases (all envelopes use Danceiny/gotry as the queried repo):
 *   PASS  (exit 0) no-closing-refs            -> 0 closing refs, pageInfo clean
 *   PASS  (exit 0) normal-child-272           -> 1 child ref, not protected
 *   PASS  (exit 0) cross-repo-same-number     -> same number, different owner/repo
 *   REJECT(exit 1) closes-protected-20        -> Danceiny/gotry#20
 *   REJECT(exit 1) closes-protected-136       -> Danceiny/gotry#136
 *   REJECT(exit 1) closes-protected-137       -> Danceiny/gotry#137
 *   REJECT(exit 1) mixed-protected-and-child  -> one protected among normal refs
 *   FAIL-CLOSED (exit 2) api-errors                   -> errors[] non-empty
 *   FAIL-CLOSED (exit 2) errors-string                -> errors is a string
 *   FAIL-CLOSED (exit 2) has-next-page                -> pageInfo.hasNextPage=true
 *   FAIL-CLOSED (exit 2) totalcount-mismatch          -> totalCount != nodes.length
 *   FAIL-CLOSED (exit 2) totalcount-zero-with-nonempty-nodes -> totalCount=0 but nodes non-empty
 *   FAIL-CLOSED (exit 2) totalcount-missing           -> totalCount key absent
 *   FAIL-CLOSED (exit 2) missing-owner-login           -> nodes[0].repository.owner.login absent
 *   FAIL-CLOSED (exit 2) null-pullrequest             -> data.repository.pullRequest = null
 *   FAIL-CLOSED (exit 2) null-repository              -> data.repository = null
 *   FAIL-CLOSED (exit 2) null-data                    -> data = null
 *   CLI/synthetic: missing-arg, unreadable, malformed-json
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const SCRIPT = join(HERE, 'protect-parent-triggers.mjs');
const FIX_DIR = join(HERE, 'protect-parent-triggers-fixtures');

const cases = [
  // exit 0 — allow (PASS)
  { name: 'no-closing-refs',                  fixture: 'no-closing-refs.json',                  expect: 0 },
  { name: 'normal-child-272',                 fixture: 'normal-child-272.json',                 expect: 0 },
  { name: 'cross-repo-same-number',           fixture: 'cross-repo-same-number.json',           expect: 0 },
  // exit 1 — reject (REJECT)
  { name: 'closes-protected-20',              fixture: 'closes-protected-20.json',              expect: 1 },
  { name: 'closes-protected-136',             fixture: 'closes-protected-136.json',             expect: 1 },
  { name: 'closes-protected-137',             fixture: 'closes-protected-137.json',             expect: 1 },
  { name: 'mixed-protected-and-child',        fixture: 'mixed-protected-and-child.json',        expect: 1 },
  // exit 2 — fail closed (any malformed/incomplete envelope must NOT pass)
  { name: 'api-errors',                       fixture: 'api-errors.json',                       expect: 2 },
  { name: 'errors-string',                    fixture: 'errors-string.json',                    expect: 2 },
  { name: 'has-next-page',                    fixture: 'has-next-page.json',                    expect: 2 },
  { name: 'totalcount-mismatch',              fixture: 'totalcount-mismatch.json',              expect: 2 },
  { name: 'totalcount-zero-with-nonempty-nodes', fixture: 'totalcount-zero-with-nonempty-nodes.json', expect: 2 },
  { name: 'totalcount-missing',               fixture: 'totalcount-missing.json',               expect: 2 },
  { name: 'missing-owner-login',              fixture: 'missing-owner-login.json',              expect: 2 },
  { name: 'null-pullrequest',                 fixture: 'null-pullrequest.json',                 expect: 2 },
  { name: 'null-repository',                  fixture: 'null-repository.json',                  expect: 2 },
  { name: 'null-data',                        fixture: 'null-data.json',                        expect: 2 },
];

// Synthetic transient cases (CLI boundary)
const tmpDir = join(HERE, '.tmp-fixtures');
mkdirSync(tmpDir, { recursive: true });
const malformedPath = join(tmpDir, 'malformed.json');
writeFileSync(malformedPath, '{ not json');
const cliCases = [
  { name: 'missing-arg',    expect: 2, synth: null },
  { name: 'unreadable',     expect: 2, synth: join(tmpDir, 'does-not-exist.json') },
  { name: 'malformed-json', expect: 2, synth: malformedPath },
];

function runChecker(inputArg) {
  return spawnSync(process.execPath, [SCRIPT, ...(inputArg === null ? [] : [inputArg])], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

let pass = 0, fail = 0;
const results = [];

// Fixture-file cases
for (const c of cases) {
  const arg = join(FIX_DIR, c.fixture);
  if (!statSync(arg, { throwIfNoFile: false })) {
    fail++;
    console.error(`  FAIL  fixture-file: ${c.fixture} missing on disk`);
    results.push({ name: c.name, expect: c.expect, actual: 'MISSING', ok: false });
    continue;
  }
  const res = runChecker(arg);
  const actual = res.status;
  const ok = actual === c.expect;
  results.push({ name: c.name, expect: c.expect, actual, ok });
  if (ok) {
    pass++;
    console.log(`  PASS  ${c.name}: exit=${actual}`);
  } else {
    fail++;
    console.error(`  FAIL  ${c.name}: expect exit=${c.expect}, got exit=${actual}`);
    if (res.stdout) console.error(`        stdout: ${res.stdout.trim()}`);
    if (res.stderr) console.error(`        stderr: ${res.stderr.trim()}`);
  }
}

// CLI synth cases
for (const c of cliCases) {
  const res = runChecker(c.synth);
  const actual = res.status;
  const ok = actual === c.expect;
  results.push({ name: c.name, expect: c.expect, actual, ok });
  if (ok) {
    pass++;
    console.log(`  PASS  ${c.name}: exit=${actual}`);
  } else {
    fail++;
    console.error(`  FAIL  ${c.name}: expect exit=${c.expect}, got exit=${actual}`);
    if (res.stdout) console.error(`        stdout: ${res.stdout.trim()}`);
    if (res.stderr) console.error(`        stderr: ${res.stderr.trim()}`);
  }
}

// Fixture-file presence audit (catches accidental deletions in the suite)
const expectedFiles = cases.map((c) => c.fixture).sort();
const present = readdirSync(FIX_DIR).filter((n) => n.endsWith('.json')).sort();
const missing = expectedFiles.filter((f) => !present.includes(f));
if (missing.length) {
  fail++;
  console.error(`  FAIL  fixture-files: missing ${missing.join(', ')}`);
} else {
  pass++;
  console.log(`  PASS  fixture-files: ${present.length} fixture JSON files present (covers every named case)`);
}

rmSync(tmpDir, { recursive: true, force: true });

console.log(`\nprotect-parent-triggers-tests: ${pass} pass / ${fail} fail (of ${pass + fail})`);
process.exit(fail === 0 ? 0 : 1);