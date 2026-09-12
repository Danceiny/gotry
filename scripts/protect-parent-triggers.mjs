#!/usr/bin/env node
/**
 * PR metadata guard: protect GoTry M4/M5/M6 parent admission issues (#20, #136, #137)
 * from automatic closure by child PRs.
 *
 * Reads the RAW GitHub GraphQL envelope (workflow output is the exact same shape).
 * Source of truth: GitHub's `closingIssuesReferences { totalCount, pageInfo, nodes }`
 * field — never parses PR title/body text and never executes PR head code.
 *
 * Contract (issue #417, post root-review 2026-09-12):
 *  - Same repo + protected number  -> REJECT (exit 1).
 *  - Neutral `Tracks #N` references and any non-protected closing references -> ALLOW (exit 0).
 *  - Different repo with the same issue number  -> ALLOW (no cross-repo misfire).
 *  - ANY of: malformed envelope / non-array or non-empty errors[] / null data.repository
 *    / null data.repository.pullRequest / missing or non-boolean pageInfo.hasNextPage /
 *    pageInfo.hasNextPage === true (incomplete page) / missing or non-integer totalCount /
 *    totalCount !== nodes.length / malformed node entries  -> FAIL CLOSED (exit 2).
 *  - The maintainer closes real gate issues explicitly per existing evidence rules;
 *    this guard does NOT introduce a new approval layer.
 *
 * Inputs:
 *   argv[2] = path to a JSON file written by the workflow's `gh api graphql` step,
 *             containing the RAW GraphQL envelope (top-level `data` and `errors`).
 *
 * No filesystem writes, no network, no dependencies, no `node -e` / eval.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const PROTECTED_PARENTS = Object.freeze([
  { number: 20, repo: 'gotry', owner: 'Danceiny' },
  { number: 136, repo: 'gotry', owner: 'Danceiny' },
  { number: 137, repo: 'gotry', owner: 'Danceiny' },
]);
const OWN_REPO_OWNER = 'Danceiny';
const OWN_REPO_NAME = 'gotry';

function failClosed(reason, detail) {
  console.error(`protect-parent-triggers: FAIL-CLOSED (${reason})${detail ? ' — ' + detail : ''}`);
  process.exit(2);
}

function isNonEmptyString(s) {
  return typeof s === 'string' && s.length > 0;
}
function isPositiveInt(n) {
  return typeof n === 'number' && Number.isInteger(n) && n > 0;
}
function isNonNegativeInt(n) {
  return typeof n === 'number' && Number.isInteger(n) && n >= 0;
}

const inputPath = process.argv[2];
if (!isNonEmptyString(inputPath)) failClosed('missing input path', 'argv[2] required');

let raw;
try {
  raw = readFileSync(resolve(inputPath), 'utf8');
} catch (e) {
  failClosed('cannot read input', String((e && e.message) || e));
}

let payload;
try {
  payload = JSON.parse(raw);
} catch (e) {
  failClosed('invalid JSON', String((e && e.message) || e));
}

if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
  failClosed('envelope not an object', typeof payload);
}

// errors[] short-circuits to fail-closed (GraphQL partial failure is propagated
// honestly, never silently coerced into a pass). A non-array `errors` value is
// itself a malformed envelope and also fails closed.
if ('errors' in payload) {
  if (!Array.isArray(payload.errors)) {
    failClosed('envelope.errors is not an array', typeof payload.errors);
  }
  if (payload.errors.length > 0) {
    failClosed('envelope.errors[] non-empty', JSON.stringify(payload.errors));
  }
}

if (!('data' in payload) || payload.data === null || typeof payload.data !== 'object' || Array.isArray(payload.data)) {
  failClosed('envelope.data missing or not an object', typeof payload.data);
}

const repo = payload.data.repository;
if (repo === null || typeof repo !== 'object' || Array.isArray(repo)) {
  failClosed('envelope.data.repository missing or null', typeof repo);
}

const pr = repo.pullRequest;
if (pr === null || typeof pr !== 'object' || Array.isArray(pr)) {
  failClosed('envelope.data.repository.pullRequest missing or null', typeof pr);
}

const cir = pr.closingIssuesReferences;
if (cir === null || typeof cir !== 'object' || Array.isArray(cir)) {
  failClosed('envelope...closingIssuesReferences missing or null', typeof cir);
}

// pageInfo MUST exist AND hasNextPage MUST be boolean AND must be false (we
// bounded query by `first: 100`; if more pages exist the workflow MUST fail
// closed instead of claiming total coverage).
const pageInfo = cir.pageInfo;
if (pageInfo === null || typeof pageInfo !== 'object' || Array.isArray(pageInfo)) {
  failClosed('pageInfo missing or not an object', typeof pageInfo);
}
if (typeof pageInfo.hasNextPage !== 'boolean') {
  failClosed('pageInfo.hasNextPage is not boolean', typeof pageInfo.hasNextPage);
}
if (pageInfo.hasNextPage === true) {
  failClosed('incomplete page', 'hasNextPage === true; bounded first:100 query would underreport');
}

// totalCount MUST be a non-negative integer AND MUST equal nodes.length.
const totalCount = cir.totalCount;
if (!isNonNegativeInt(totalCount)) {
  failClosed('totalCount missing or not non-negative integer', typeof totalCount);
}

if (!Array.isArray(cir.nodes)) {
  failClosed('nodes missing or not an array', typeof cir.nodes);
}

if (totalCount !== cir.nodes.length) {
  failClosed('totalCount !== nodes.length', `totalCount=${totalCount} nodes.length=${cir.nodes.length}`);
}

// Now validate every node.
const refs = cir.nodes;
for (let i = 0; i < refs.length; i++) {
  const r = refs[i];
  if (r === null || typeof r !== 'object' || Array.isArray(r)) {
    failClosed(`nodes[${i}] not an object`, typeof r);
  }
  if (!isPositiveInt(r.number)) {
    failClosed(`nodes[${i}].number not positive integer`, JSON.stringify(r.number));
  }
  if (r.repository === null || typeof r.repository !== 'object' || Array.isArray(r.repository)) {
    failClosed(`nodes[${i}].repository missing or null`, typeof r.repository);
  }
  if (!isNonEmptyString(r.repository.name)) {
    failClosed(`nodes[${i}].repository.name missing`, JSON.stringify((r.repository || {}).name));
  }
  if (r.repository.owner === null || typeof r.repository.owner !== 'object' || Array.isArray(r.repository.owner)) {
    failClosed(`nodes[${i}].repository.owner missing or null`, typeof r.repository.owner);
  }
  if (!isNonEmptyString(r.repository.owner.login)) {
    failClosed(`nodes[${i}].repository.owner.login missing`, JSON.stringify((r.repository.owner || {}).login));
  }
}

// Same number across different repo/owner must NOT misfire.
const violations = [];
for (const r of refs) {
  const isOwnRepo = r.repository.owner.login === OWN_REPO_OWNER && r.repository.name === OWN_REPO_NAME;
  if (!isOwnRepo) continue;
  const hit = PROTECTED_PARENTS.find(
    (p) => p.number === r.number && p.repo === r.repository.name && p.owner === r.repository.owner.login,
  );
  if (hit) {
    violations.push(`${OWN_REPO_OWNER}/${OWN_REPO_NAME}#${r.number}`);
  }
}

if (violations.length > 0) {
  console.error(
    `protect-parent-triggers: REJECT — PR would auto-close protected parent admission issue(s): ${violations.join(', ')}.`,
  );
  console.error(
    'Remediation: replace `Closes #N` / `Fixes #N` in the PR body with neutral `Tracks #N` or `Refs #N`;',
  );
  console.error(
    'the maintainer closes M4/M5/M6 parent admission trackers (#20/#136/#137) explicitly after evidence acceptance per existing rules.',
  );
  process.exit(1);
}

console.log(
  `protect-parent-triggers: PASS — ${refs.length} closing reference(s), totalCount=${totalCount}, none auto-close protected parent admission trackers.`,
);
process.exit(0);