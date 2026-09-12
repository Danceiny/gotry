#!/usr/bin/env node
/**
 * PR metadata guard: protect GoTry M4/M5/M6 parent admission issues (#20, #136, #137)
 * from automatic closure by child PRs based on GitHub's authoritative
 * `closingIssuesReferences` (GraphQL field), not on homegrown keyword parsing.
 *
 * Contract (issue #417):
 *  - Same repo + protected number  -> REJECT (exit 1, never auto-closes the parent).
 *  - Neutral `Tracks #20` references and other non-closing mentions  -> ALLOW (exit 0).
 *  - Different repo with the same issue number  -> ALLOW (do not misfire cross-repo).
 *  - Invalid / missing / error / incomplete API response  -> FAIL CLOSED (exit 2).
 *  - The maintainer closes real gate issues explicitly per existing evidence rules;
 *    this guard does NOT introduce a new approval layer.
 *
 * Inputs:
 *   argv[2] = path to a JSON file written by the workflow:
 *     { closingIssuesReferences: Array<{number:int, repository:{name, owner:{login}}}>,
 *       errors?: string[] }
 *
 * No filesystem writes, no network, no dependencies.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const PROTECTED_PARENTS = Object.freeze([
  { number: 20, repo: 'gotry', owner: 'Danceiny' },
  { number: 136, repo: 'gotry', owner: 'Danceiny' },
  { number: 137, repo: 'gotry', owner: 'Danceiny' },
]);

const OWN_REPO = 'Danceiny/gotry';

function failClosed(reason, detail) {
  console.error(`protect-parent-triggers: FAIL-CLOSED (${reason})${detail ? ' — ' + detail : ''}`);
  process.exit(2);
}

function isPositiveInt(n) {
  return typeof n === 'number' && Number.isInteger(n) && n > 0;
}

function isNonEmptyString(s) {
  return typeof s === 'string' && s.length > 0;
}

const inputPath = process.argv[2];
if (!isNonEmptyString(inputPath)) failClosed('missing input path', 'argv[2] required');

let raw;
try {
  raw = readFileSync(resolve(inputPath), 'utf8');
} catch (e) {
  failClosed('cannot read input', String(e && e.message || e));
}

let payload;
try {
  payload = JSON.parse(raw);
} catch (e) {
  failClosed('invalid JSON', String(e && e.message || e));
}

if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
  failClosed('payload not an object', 'expected top-level object');
}

// errors[] short-circuits to fail-closed (GraphQL partial failure is propagated
// honestly, never silently coerced into a pass).
if (Array.isArray(payload.errors) && payload.errors.length > 0) {
  failClosed('API errors[] present', JSON.stringify(payload.errors));
}

// closingIssuesReferences MUST be an array; absent / non-array / element type mismatch
// all fail closed.
if (!Array.isArray(payload.closingIssuesReferences)) {
  failClosed('closingIssuesReferences missing or not an array', typeof payload.closingIssuesReferences);
}

const refs = payload.closingIssuesReferences;
for (let i = 0; i < refs.length; i++) {
  const r = refs[i];
  if (r === null || typeof r !== 'object' || Array.isArray(r)) {
    failClosed(`ref[${i}] not an object`, typeof r);
  }
  if (!isPositiveInt(r.number)) {
    failClosed(`ref[${i}].number not positive integer`, JSON.stringify(r.number));
  }
  if (r.repository === null || typeof r.repository !== 'object' || Array.isArray(r.repository)) {
    failClosed(`ref[${i}].repository not an object`, typeof r.repository);
  }
  if (!isNonEmptyString(r.repository.name)) {
    failClosed(`ref[${i}].repository.name missing`, JSON.stringify(r.repository && r.repository.name));
  }
  if (r.repository.owner === null || typeof r.repository.owner !== 'object' || Array.isArray(r.repository.owner)) {
    failClosed(`ref[${i}].repository.owner not an object`, typeof r.repository.owner);
  }
  if (!isNonEmptyString(r.repository.owner.login)) {
    failClosed(`ref[${i}].repository.owner.login missing`, JSON.stringify(r.repository.owner && r.repository.owner.login));
  }
}

const violations = [];
for (const r of refs) {
  const isOwnRepo = r.repository.owner.login === 'Danceiny' && r.repository.name === 'gotry';
  if (!isOwnRepo) continue; // cross-repo same number does NOT misfire
  const hit = PROTECTED_PARENTS.find(
    (p) => p.number === r.number && p.repo === r.repository.name && p.owner === r.repository.owner.login,
  );
  if (hit) {
    violations.push(`${OWN_REPO}#${r.number}`);
  }
}

if (violations.length > 0) {
  console.error(
    `protect-parent-triggers: REJECT — PR would auto-close protected parent admission issue(s): ${violations.join(', ')}.`
  );
  console.error(
    'Remediation: replace `Closes #N` / `Fixes #N` in the PR body with neutral `Tracks #N` or `Refs #N`;'
  );
  console.error(
    'the maintainer closes M4/M5/M6 parent admission trackers (#20/#136/#137) explicitly after evidence acceptance per existing rules.'
  );
  process.exit(1);
}

console.log(
  `protect-parent-triggers: PASS — ${refs.length} closing reference(s), none auto-close protected parent admission trackers.`
);
process.exit(0);