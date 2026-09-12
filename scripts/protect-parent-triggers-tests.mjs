#!/usr/bin/env node
/**
 * Fixture tests for scripts/protect-parent-triggers.mjs (issue #417).
 *
 * Each case asserts the actual checker exit status. We do NOT trust the script's
 * stdout alone; the contract is the exit code and the exit code alone.
 *
 * Cases (all use the GoTry repo "Danceiny/gotry" as own repo):
 *   1. no-closing-refs             -> exit 0 (allow, nothing to check)
 *   2. normal-child-272            -> exit 0 (allow, child not on protected list)
 *   3. closes-protected-20         -> exit 1 (reject, would auto-close #20)
 *   4. closes-protected-136        -> exit 1 (reject, would auto-close #136)
 *   5. closes-protected-137        -> exit 1 (reject, would auto-close #137)
 *   6. cross-repo-same-number      -> exit 0 (allow, different repo/owner)
 *   7. mixed-protected-and-child   -> exit 1 (reject, even one protected hit fails)
 *   8. api-errors                  -> exit 2 (fail-closed on GraphQL errors[])
 *   9. invalid-shape               -> exit 2 (fail-closed on wrong shape)
 *  10. missing-owner               -> exit 2 (fail-closed on incomplete payload)
 *  11. missing-arg                 -> exit 2 (fail-closed on no input path)
 *  12. unreadable                  -> exit 2 (fail-closed on missing file)
 *  13. malformed-json              -> exit 2 (fail-closed on parse error)
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
  { name: 'no-closing-refs',            fixture: 'no-closing-refs.json',            expect: 0 },
  { name: 'normal-child-272',           fixture: 'normal-child-272.json',           expect: 0 },
  { name: 'closes-protected-20',        fixture: 'closes-protected-20.json',        expect: 1 },
  { name: 'closes-protected-136',       fixture: 'closes-protected-136.json',       expect: 1 },
  { name: 'closes-protected-137',       fixture: 'closes-protected-137.json',       expect: 1 },
  { name: 'cross-repo-same-number',     fixture: 'cross-repo-same-number.json',     expect: 0 },
  { name: 'mixed-protected-and-child',  fixture: 'mixed-protected-and-child.json',  expect: 1 },
  { name: 'api-errors',                 fixture: 'api-errors.json',                 expect: 2 },
  { name: 'invalid-shape',              fixture: 'invalid-shape.json',              expect: 2 },
  { name: 'missing-owner',              fixture: 'missing-owner.json',              expect: 2 },
];

// Synthetic transient fixtures
const tmpDir = join(HERE, '.tmp-fixtures');
mkdirSync(tmpDir, { recursive: true });
const malformedPath = join(tmpDir, 'malformed.json');
writeFileSync(malformedPath, '{ not json');

const casesWithSynth = [
  ...cases,
  { name: 'missing-arg',    fixture: null, expect: 2, synth: null },
  { name: 'unreadable',     fixture: null, expect: 2, synth: join(tmpDir, 'does-not-exist.json') },
  { name: 'malformed-json', fixture: null, expect: 2, synth: malformedPath },
];

function runChecker(inputArg) {
  return spawnSync(process.execPath, [SCRIPT, ...(inputArg === null ? [] : [inputArg])], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

let pass = 0, fail = 0;
const results = [];
for (const c of casesWithSynth) {
  let arg;
  if (c.synth !== undefined) {
    arg = c.synth;
  } else {
    arg = join(FIX_DIR, c.fixture);
    if (!statSync(arg, { throwIfNoFile: false })) {
      console.error(`fixture missing: ${arg}`);
      process.exit(2);
    }
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

// Verify default fixtures directory has the expected files (catches accidental deletions)
const expectedFiles = cases.map((c) => c.fixture).sort();
const present = readdirSync(FIX_DIR).filter((n) => n.endsWith('.json')).sort();
const missing = expectedFiles.filter((f) => !present.includes(f));
if (missing.length) {
  fail++;
  console.error(`  FAIL  fixture-files: missing ${missing.join(', ')}`);
} else {
  pass++;
  console.log(`  PASS  fixture-files: ${present.length} fixture JSON files present`);
}

rmSync(tmpDir, { recursive: true, force: true });

console.log(`\nprotect-parent-triggers-tests: ${pass} pass / ${fail} fail (of ${pass + fail})`);
process.exit(fail === 0 ? 0 : 1);