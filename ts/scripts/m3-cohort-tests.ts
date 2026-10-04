/**
 * M3 seed-cohort capture tests (issue #22).
 *
 * Covers explicit opt-in, HMAC pseudonymity, append-only idempotency, fail-closed
 * transitions, path isolation, and the four synthetic-labelling falsifications:
 *   (a) a simulated cohort can never reach `business_pass=true`;
 *   (b) simulated records can never be mixed into a `real_seed_cohort` store or root;
 *   (c) a PII sentinel never reaches any persisted byte;
 *   (d) relabelling a synthetic export as real breaks the export attestation.
 * Each falsification carries its red baseline: the same numbers, hand-written without the
 * capture gate, are accepted by the scorer alone — which is exactly what the gate prevents.
 *
 * Run: cd ts && npx tsx scripts/m3-cohort-tests.ts
 */

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  buildExportPayload,
  canonicalJson,
  cohortRecordLines,
  enrollParticipant,
  exportM3Cohort,
  fileMode,
  initM3Cohort,
  M3CohortError,
  M3_ACCEPTANCE,
  M3_EXCLUSION_CODES,
  M3_SIMULATION_PROVENANCE_SCHEMA,
  participantKeyFor,
  planKeyFor,
  readStoreForTests,
  recordNps,
  recordPlanDelivered,
  recordPlanFinalized,
  recordPoiLock,
  storeRootForStateRoot,
  verifyExportedEvidence,
  type Clock,
  type M3Attribution,
  type M3CohortErrorCode,
  type M3SimulationProvenance,
} from '../src/m3-cohort.ts'
import { parseCohortRecord, parseManifest, scoreProductMetrics } from './product-metrics.ts'

const __dirname = dirname(fileURLToPath(import.meta.url))
const TS_ROOT = resolve(__dirname, '..')
const TSX = join(TS_ROOT, 'node_modules', '.bin', process.platform === 'win32' ? 'tsx.cmd' : 'tsx')
const KEY = '0123456789abcdef0123456789abcdef'
const OTHER_KEY = 'fedcba9876543210fedcba9876543210'
const CONSENT = 'operator-consent-for-issue-22'
const SENTINEL = 'PRIVACY_SENTINEL_22@example.com'
const WINDOW_START = '2026-10-01T00:00:00.000Z'
const WINDOW_END = '2026-12-31T23:59:59.000Z'
const DIGEST = 'a'.repeat(64)

const SIMULATION: M3SimulationProvenance = {
  schema_version: M3_SIMULATION_PROVENANCE_SCHEMA,
  kind: 'llm_persona',
  persona_id: 'erhai-weekend-unwind',
  product_model: 'MiniMax-M2',
  persona_model: 'MiniMax-M2',
  prompt_digest: DIGEST,
}

function stepClock(startIso = '2026-10-05T00:00:00.000Z'): Clock {
  let ms = Date.parse(startIso)
  return { now: () => { ms += 1_000; return new Date(ms) } }
}

const roots: string[] = []
function newRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'gotry-m3-cohort-'))
  roots.push(root)
  return root
}

let n = 0
async function pass(name: string, body: () => void | Promise<void>): Promise<void> {
  await body()
  console.log(`  ${++n}. ${name} OK`)
}

function expectCode(code: M3CohortErrorCode, body: () => unknown): void {
  assert.throws(body, (error: unknown) => {
    assert.ok(error instanceof M3CohortError, `expected M3CohortError, got ${String(error)}`)
    assert.equal(error.code, code)
    return true
  })
}

function common(root: string, key = KEY, consent = CONSENT) {
  return { stateRoot: root, consent, hmacKey: key }
}

function initArgs(root: string, evidenceKind: 'real_seed_cohort' | 'synthetic_fixture', key = KEY) {
  return {
    ...common(root, key),
    cohort: `cohort-${evidenceKind}`,
    evidenceKind,
    windowStartAt: WINDOW_START,
    windowEndAt: WINDOW_END,
    timezone: 'Asia/Shanghai',
    allowedAttribution: ['gotry_primary', 'gotry_assisted'] as M3Attribution[],
  }
}

function allFileText(root: string): string {
  const parts: string[] = []
  function walk(path: string): void {
    if (!existsSync(path)) return
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const child = join(path, entry.name)
      if (entry.isDirectory()) walk(child)
      else parts.push(readFileSync(child, 'utf8'))
    }
  }
  walk(root)
  return parts.join('\n')
}

/** `null` means "run with no HMAC key in the environment" — a default parameter cannot
 *  express that, because passing `undefined` would re-apply the default. */
function runCli(args: string[], key: string | null = KEY) {
  const env: NodeJS.ProcessEnv = { ...process.env }
  if (key === null) delete env['GOTRY_M3_COHORT_HMAC_KEY']
  else env['GOTRY_M3_COHORT_HMAC_KEY'] = key
  return spawnSync(TSX, ['scripts/m3-cohort.ts', ...args], { cwd: TS_ROOT, env, encoding: 'utf8', timeout: 120_000 })
}

function runScorerCli(evidenceRoot: string) {
  return spawnSync(TSX, ['scripts/product-metrics.ts', '--evidence-root', evidenceRoot, '--format', 'json'], {
    cwd: TS_ROOT,
    encoding: 'utf8',
    timeout: 120_000,
  })
}

/** A full funnel for one participant; returns its pseudonymous keys. */
function captureOne(
  root: string,
  kind: 'real_seed_cohort' | 'synthetic_fixture',
  participant: string,
  clock: Clock,
  options: { invited?: boolean; consent?: boolean; testOrStaff?: boolean; finalize?: boolean; nps?: number | null; locked?: number; invalid?: number } = {},
): { participantKey: string; planKey: string } {
  const plan = `${participant}-plan`
  enrollParticipant({
    ...common(root),
    participant,
    invited: options.invited ?? true,
    participantConsent: options.consent ?? true,
    testOrStaff: options.testOrStaff ?? false,
    simulation: kind === 'synthetic_fixture' ? { ...SIMULATION, persona_id: 'erhai-weekend-unwind' } : undefined,
  }, clock)
  recordPlanDelivered({ ...common(root), participant, plan, attribution: 'gotry_primary' }, clock)
  if (options.finalize !== false) recordPlanFinalized({ ...common(root), participant, plan }, clock)
  const score = options.nps === undefined ? 10 : options.nps
  if (score !== null) recordNps({ ...common(root), participant, plan, score }, clock)
  recordPoiLock({ ...common(root), participant, plan, lockedClaims: options.locked ?? 8, invalidClaims: options.invalid ?? 0 }, clock)
  return {
    participantKey: participantKeyFor(KEY, kind, participant),
    planKey: planKeyFor(KEY, kind, participant, plan),
  }
}

/** Hand-written evidence root that bypasses the capture gate entirely. This is the red
 *  baseline: the scorer alone cannot tell it is fabricated. */
function writeHandMadeEvidenceRoot(
  root: string,
  evidenceKind: 'real_seed_cohort' | 'synthetic_fixture',
  participants: number,
): string {
  mkdirSync(root, { recursive: true })
  const manifest = {
    schema_version: 'gotry_m3_evidence_manifest_v1',
    evidence_kind: evidenceKind,
    cohort_id: `hmac-sha256:${'b'.repeat(64)}`,
    locked_at: '2026-12-31T23:59:59.000Z',
    window: { start_at: WINDOW_START, end_at: WINDOW_END, timezone: 'Asia/Shanghai' },
    eligibility: {
      sample_unit: 'unique_participant_with_eligible_delivered_plan',
      requires_invitation: true,
      requires_consent: true,
      allowed_attribution: ['gotry_primary', 'gotry_assisted'],
      exclusion_codes: [...M3_EXCLUSION_CODES],
    },
    metrics: {
      sample_size: { minimum: M3_ACCEPTANCE.sampleMinimum, maximum: M3_ACCEPTANCE.sampleMaximum },
      finalization_rate: { formula: 'finalized_eligible_delivered_plans / eligible_delivered_plans', minimum: M3_ACCEPTANCE.finalizationMinimum },
      nps: { formula: '100 * (promoters_9_10 - detractors_0_6) / valid_responses', minimum: M3_ACCEPTANCE.npsMinimum },
      poi_hallucination_rate: { formula: 'audited_invalid_poi_claims / locked_audited_poi_claims', exclusive_maximum: M3_ACCEPTANCE.poiExclusiveMaximum },
    },
    nightly: { requires_real_llm: true, requires_prompt_set_sha256: true, requires_output_sha256: true, requires_cost_usd: true },
  }
  const lines: string[] = []
  for (let i = 0; i < participants; i += 1) {
    const hex = i.toString(16).padStart(4, '0')
    lines.push(JSON.stringify({
      schema_version: 'gotry_m3_cohort_record_v1',
      participant_key: `hmac-sha256:${hex}${'c'.repeat(60)}`,
      plan_key: `hmac-sha256:${hex}${'d'.repeat(60)}`,
      invited: true,
      consent: true,
      test_or_staff: false,
      attribution: 'gotry_primary',
      delivered_at: '2026-11-01T00:00:00.000Z',
      finalized_at: '2026-11-02T00:00:00.000Z',
      nps_score: 10,
      nps_recorded_at: '2026-11-03T00:00:00.000Z',
      poi_audit: { locked_at: '2026-11-04T00:00:00.000Z', locked_claims: 10, invalid_claims: 0 },
    }))
  }
  lines.push(JSON.stringify({
    schema_version: 'gotry_m3_nightly_run_v1',
    run_key: `hmac-sha256:${'e'.repeat(64)}`,
    executed_at: '2026-11-05T00:00:00.000Z',
    real_llm: true,
    prompt_set_sha256: 'f'.repeat(64),
    output_sha256: '9'.repeat(64),
    cost_usd: 0.12,
  }))
  writeFileSync(join(root, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  writeFileSync(join(root, 'cohort.jsonl'), `${lines.join('\n')}\n`, 'utf8')
  return root
}

async function main(): Promise<void> {
  console.log('M3 cohort capture tests')

  await pass('init freezes the scorer-shaped manifest; re-init is idempotent', () => {
    const root = newRoot()
    const first = initM3Cohort(initArgs(root, 'synthetic_fixture'), stepClock())
    assert.equal(first.status, 'recorded')
    assert.equal(first.evidence_kind, 'synthetic_fixture')
    assert.match(first.cohort_ref!, /^hmac-sha256:[0-9a-f]{64}$/)
    const again = initM3Cohort(initArgs(root, 'synthetic_fixture'), stepClock())
    assert.equal(again.status, 'unchanged')
    assert.equal(again.cohort_ref, first.cohort_ref)
    const { manifest } = readStoreForTests(root)
    // The frozen evidence manifest must satisfy the real scorer parser verbatim.
    const parsed = parseManifest(JSON.parse(JSON.stringify(manifest.evidence_manifest)))
    assert.equal(parsed.evidence_kind, 'synthetic_fixture')
    assert.equal(parsed.cohort_id, first.cohort_ref)
    assert.deepEqual(parsed.eligibility.exclusion_codes.slice().sort(), [...M3_EXCLUSION_CODES].sort())
    assert.equal(parsed.metrics.sample_size.minimum, 50)
    assert.equal(parsed.metrics.nps.minimum, 40)
  })

  await pass('init refuses a changed window / changed kind on the same store', () => {
    const root = newRoot()
    initM3Cohort(initArgs(root, 'synthetic_fixture'), stepClock())
    expectCode('cohort_already_initialized', () => initM3Cohort({ ...initArgs(root, 'synthetic_fixture'), windowEndAt: '2027-01-31T00:00:00.000Z' }, stepClock()))
    expectCode('evidence_kind_mismatch', () => initM3Cohort(initArgs(root, 'real_seed_cohort'), stepClock()))
    expectCode('cohort_key_mismatch', () => initM3Cohort(initArgs(root, 'synthetic_fixture', OTHER_KEY), stepClock()))
    expectCode('cohort_consent_mismatch', () => initM3Cohort({ ...initArgs(root, 'synthetic_fixture'), consent: 'different consent' }, stepClock()))
  })

  await pass('opt-in only: missing key / consent / state root write nothing', () => {
    const root = newRoot()
    expectCode('missing_hmac_key', () => initM3Cohort({ ...initArgs(root, 'synthetic_fixture'), hmacKey: undefined }, stepClock()))
    expectCode('invalid_hmac_key', () => initM3Cohort({ ...initArgs(root, 'synthetic_fixture'), hmacKey: 'too-short' }, stepClock()))
    expectCode('missing_consent', () => initM3Cohort({ ...initArgs(root, 'synthetic_fixture'), consent: '' }, stepClock()))
    expectCode('missing_state_root', () => initM3Cohort({ ...initArgs(root, 'synthetic_fixture'), stateRoot: '' }, stepClock()))
    assert.equal(existsSync(storeRootForStateRoot(root)), false, 'no store directory may exist after refused commands')
    expectCode('cohort_not_initialized', () => enrollParticipant({ ...common(root), participant: 'p1', invited: true, participantConsent: true, testOrStaff: false }, stepClock()))
    assert.equal(existsSync(storeRootForStateRoot(root)), false)
  })

  await pass('product state roots are refused (ts/dsh-runtime, ~/.dsh, ~/.gotry, .git)', () => {
    for (const unsafe of [
      join(TS_ROOT, 'dsh-runtime'),
      join(TS_ROOT, 'dsh-runtime', 'nested'),
      join(newRoot(), '.dsh'),
      join(newRoot(), '.gotry'),
      join(resolve(TS_ROOT, '..'), '.git'),
    ]) {
      expectCode('unsafe_state_root', () => initM3Cohort(initArgs(unsafe, 'synthetic_fixture'), stepClock()))
    }
  })

  await pass('(b) a simulated participant is refused by a real_seed_cohort store', () => {
    const root = newRoot()
    initM3Cohort(initArgs(root, 'real_seed_cohort'), stepClock())
    expectCode('simulation_forbidden_in_real_cohort', () => enrollParticipant({
      ...common(root), participant: 'p1', invited: true, participantConsent: true, testOrStaff: false, simulation: SIMULATION,
    }, stepClock()))
    assert.equal(readStoreForTests(root).events.length, 0, 'a refused enrollment must append nothing')
  })

  await pass('(b) an unlabelled participant is refused by a synthetic_fixture store', () => {
    const root = newRoot()
    initM3Cohort(initArgs(root, 'synthetic_fixture'), stepClock())
    expectCode('simulation_label_required', () => enrollParticipant({
      ...common(root), participant: 'p1', invited: true, participantConsent: true, testOrStaff: false,
    }, stepClock()))
    assert.equal(readStoreForTests(root).events.length, 0)
  })

  await pass('funnel is append-only and idempotent; replays return unchanged', () => {
    const root = newRoot()
    const clock = stepClock()
    initM3Cohort(initArgs(root, 'real_seed_cohort'), clock)
    captureOne(root, 'real_seed_cohort', 'participant-one', clock)
    const after = readStoreForTests(root).events.length
    assert.equal(after, 5, 'enroll + deliver + finalize + nps + poi-lock')
    const replays = [
      enrollParticipant({ ...common(root), participant: 'participant-one', invited: true, participantConsent: true, testOrStaff: false }, clock),
      recordPlanDelivered({ ...common(root), participant: 'participant-one', plan: 'participant-one-plan', attribution: 'gotry_primary' }, clock),
      recordPlanFinalized({ ...common(root), participant: 'participant-one', plan: 'participant-one-plan' }, clock),
      recordNps({ ...common(root), participant: 'participant-one', plan: 'participant-one-plan', score: 10 }, clock),
      recordPoiLock({ ...common(root), participant: 'participant-one', plan: 'participant-one-plan', lockedClaims: 8, invalidClaims: 0 }, clock),
    ]
    for (const replay of replays) assert.equal(replay.status, 'unchanged', `${replay.command} must be idempotent`)
    assert.equal(readStoreForTests(root).events.length, after, 'idempotent replays must not grow the log')
  })

  await pass('out-of-order and out-of-range submissions fail closed', () => {
    const root = newRoot()
    const clock = stepClock()
    initM3Cohort(initArgs(root, 'real_seed_cohort'), clock)
    expectCode('invalid_transition', () => recordPlanDelivered({ ...common(root), participant: 'ghost', plan: 'ghost-plan', attribution: 'gotry_primary' }, clock))
    enrollParticipant({ ...common(root), participant: 'p1', invited: true, participantConsent: true, testOrStaff: false }, clock)
    expectCode('invalid_transition', () => recordPlanFinalized({ ...common(root), participant: 'p1', plan: 'p1-plan' }, clock))
    expectCode('invalid_transition', () => recordNps({ ...common(root), participant: 'p1', plan: 'p1-plan', score: 9 }, clock))
    expectCode('invalid_transition', () => recordPoiLock({ ...common(root), participant: 'p1', plan: 'p1-plan', lockedClaims: 1, invalidClaims: 0 }, clock))
    recordPlanDelivered({ ...common(root), participant: 'p1', plan: 'p1-plan', attribution: 'gotry_primary' }, clock)
    expectCode('invalid_input', () => recordNps({ ...common(root), participant: 'p1', plan: 'p1-plan', score: 11 }, clock))
    expectCode('invalid_input', () => recordNps({ ...common(root), participant: 'p1', plan: 'p1-plan', score: 1.5 }, clock))
    expectCode('invalid_input', () => recordPoiLock({ ...common(root), participant: 'p1', plan: 'p1-plan', lockedClaims: 2, invalidClaims: 3 }, clock))
    recordNps({ ...common(root), participant: 'p1', plan: 'p1-plan', score: 9 }, clock)
    // The scorer throws on two NPS responses from one participant in the window, so the
    // capture side refuses the second one at write time.
    recordPlanDelivered({ ...common(root), participant: 'p1', plan: 'p1-plan-b', attribution: 'gotry_primary' }, clock)
    expectCode('invalid_transition', () => recordNps({ ...common(root), participant: 'p1', plan: 'p1-plan-b', score: 8 }, clock))
  })

  await pass('plan keys and participant keys are domain-separated by evidence kind', () => {
    assert.notEqual(participantKeyFor(KEY, 'real_seed_cohort', 'p1'), participantKeyFor(KEY, 'synthetic_fixture', 'p1'))
    assert.notEqual(planKeyFor(KEY, 'real_seed_cohort', 'p1', 'plan'), planKeyFor(KEY, 'synthetic_fixture', 'p1', 'plan'))
    assert.notEqual(participantKeyFor(KEY, 'real_seed_cohort', 'p1'), participantKeyFor(OTHER_KEY, 'real_seed_cohort', 'p1'))
  })

  await pass('(c) a PII sentinel never reaches a persisted byte', () => {
    const root = newRoot()
    const clock = stepClock()
    initM3Cohort({ ...initArgs(root, 'synthetic_fixture'), cohort: SENTINEL }, clock)
    captureOne(root, 'synthetic_fixture', SENTINEL, clock)
    const evidenceRoot = join(root, 'evidence')
    exportM3Cohort({ ...common(root), evidenceRoot, validate: undefined }, clock)
    for (const scope of [storeRootForStateRoot(root), evidenceRoot]) {
      const text = allFileText(scope)
      assert.equal(text.includes(SENTINEL), false, `sentinel leaked into ${scope}`)
      assert.equal(text.includes('PRIVACY_SENTINEL'), false, `sentinel fragment leaked into ${scope}`)
      assert.equal(text.includes(KEY), false, `HMAC key leaked into ${scope}`)
    }
  })

  await pass('store files are private (0600) under a private directory (0700)', () => {
    const root = newRoot()
    const clock = stepClock()
    initM3Cohort(initArgs(root, 'real_seed_cohort'), clock)
    captureOne(root, 'real_seed_cohort', 'p1', clock)
    const storeRoot = storeRootForStateRoot(root)
    assert.equal(statSync(storeRoot).mode & 0o777, 0o700)
    assert.equal(fileMode(join(storeRoot, 'manifest.json')), 0o600)
    assert.equal(fileMode(join(storeRoot, 'events.jsonl')), 0o600)
  })

  await pass('a competing writer lock returns lock_busy and writes nothing', () => {
    const root = newRoot()
    const clock = stepClock()
    initM3Cohort(initArgs(root, 'real_seed_cohort'), clock)
    const lockPath = join(storeRootForStateRoot(root), '.writer.lock')
    writeFileSync(lockPath, '{"pid":1}', { mode: 0o600 })
    try {
      expectCode('lock_busy', () => enrollParticipant({ ...common(root), participant: 'p1', invited: true, participantConsent: true, testOrStaff: false }, clock))
      assert.equal(readStoreForTests(root).events.length, 0)
    } finally {
      rmSync(lockPath, { force: true })
    }
  })

  await pass('export emits exactly the scorer v1 shapes and skips un-audited plans', () => {
    const root = newRoot()
    const clock = stepClock()
    initM3Cohort(initArgs(root, 'real_seed_cohort'), clock)
    captureOne(root, 'real_seed_cohort', 'p1', clock)
    // Delivered but never POI-locked: not exportable, because the scorer requires poi_audit
    // and the capture side refuses to invent one.
    enrollParticipant({ ...common(root), participant: 'p2', invited: true, participantConsent: true, testOrStaff: false }, clock)
    recordPlanDelivered({ ...common(root), participant: 'p2', plan: 'p2-plan', attribution: 'gotry_assisted' }, clock)
    const evidenceRoot = join(root, 'evidence')
    const { payload } = exportM3Cohort({ ...common(root), evidenceRoot }, clock)
    assert.equal(payload.cohort.length, 1)
    assert.equal(payload.provenance.length, 0)
    const record = payload.cohort[0]!
    assert.deepEqual(Object.keys(record).sort(), [
      'attribution', 'consent', 'delivered_at', 'finalized_at', 'invited', 'nps_recorded_at',
      'nps_score', 'participant_key', 'plan_key', 'poi_audit', 'schema_version', 'test_or_staff',
    ])
    // The real consumer CLI must read the written root.
    const scorer = runScorerCli(evidenceRoot)
    assert.equal(scorer.status, 0, `${scorer.stderr}\n${scorer.stdout}`)
    const summary = JSON.parse(scorer.stdout) as { evidence_kind: string; business_pass: boolean; sample: { participants: number } }
    assert.equal(summary.evidence_kind, 'real_seed_cohort')
    assert.equal(summary.sample.participants, 1)
    assert.equal(summary.business_pass, false, 'one participant cannot clear the 50-sample floor')
    assert.equal(verifyExportedEvidence(evidenceRoot).record_count, 1)
    // No-overwrite: a second export into the same root refuses rather than rewriting.
    expectCode('output_exists', () => exportM3Cohort({ ...common(root), evidenceRoot }, clock))
  })

  await pass('test_or_staff participants land in the scorer exclusion counters', () => {
    const root = newRoot()
    const clock = stepClock()
    initM3Cohort(initArgs(root, 'real_seed_cohort'), clock)
    captureOne(root, 'real_seed_cohort', 'real-one', clock)
    captureOne(root, 'real_seed_cohort', 'staff-one', clock, { testOrStaff: true })
    captureOne(root, 'real_seed_cohort', 'uninvited-one', clock, { invited: false })
    captureOne(root, 'real_seed_cohort', 'withdrawn-one', clock, { consent: false })
    const evidenceRoot = join(root, 'evidence')
    const { payload } = exportM3Cohort({ ...common(root), evidenceRoot }, clock)
    const manifest = parseManifest(JSON.parse(JSON.stringify(payload.manifest)))
    const cohort = payload.cohort.map((item, index) => parseCohortRecord(JSON.parse(JSON.stringify(item)), index))
    const summary = scoreProductMetrics(manifest, cohort, [])
    assert.equal(summary.exclusions['test_or_staff'], 1)
    assert.equal(summary.exclusions['not_invited'], 1)
    assert.equal(summary.exclusions['consent_missing_or_withdrawn'], 1)
    assert.equal(summary.sample.participants, 1, 'only the clean participant is eligible')
  })

  await pass('(a) a flawless simulated cohort still cannot reach business_pass', () => {
    const root = newRoot()
    const clock = stepClock()
    initM3Cohort(initArgs(root, 'synthetic_fixture'), clock)
    for (let i = 0; i < M3_ACCEPTANCE.sampleMinimum; i += 1) {
      captureOne(root, 'synthetic_fixture', `sim-${String(i).padStart(3, '0')}`, clock, { nps: 10, locked: 10, invalid: 0 })
    }
    const evidenceRoot = join(root, 'evidence')
    const { payload } = exportM3Cohort({ ...common(root), evidenceRoot }, clock)
    assert.equal(payload.cohort.length, 50)
    assert.equal(payload.provenance.length, 50, 'every simulated record carries provenance')
    // Append the nightly real-LLM record the gate also needs, so every single non-kind
    // check passes and only evidence_kind is left standing between this and a pass.
    const manifest = parseManifest(JSON.parse(JSON.stringify(payload.manifest)))
    const cohort = payload.cohort.map((item, index) => parseCohortRecord(JSON.parse(JSON.stringify(item)), index))
    const summary = scoreProductMetrics(manifest, cohort, [{
      schema_version: 'gotry_m3_nightly_run_v1',
      run_key: `hmac-sha256:${'e'.repeat(64)}`,
      executed_at: '2026-11-05T00:00:00.000Z',
      real_llm: true,
      prompt_set_sha256: 'f'.repeat(64),
      output_sha256: '9'.repeat(64),
      cost_usd: 0.12,
    }])
    assert.equal(summary.sample.pass, true)
    assert.equal(summary.finalization.rate, 1)
    assert.equal(summary.nps.score, 100)
    assert.equal(summary.poi_hallucination.rate, 0)
    assert.equal(summary.nightly.pass, true)
    assert.equal(summary.business_pass, false, 'every metric passes and business_pass is still false')
    assert.equal(summary.business_pass_reason, 'evidence_kind=synthetic_fixture cannot prove business pass')
  })

  await pass('(a)/(b) red baseline: the same numbers hand-written as real DO pass the scorer', () => {
    // Without the capture gate nothing stops a fabricated real_seed_cohort root from
    // scoring a full business pass. This is the failure the gate and the attestation
    // exist to make detectable; it is reproduced here so the guard is not self-evident.
    const realRoot = writeHandMadeEvidenceRoot(join(newRoot(), 'hand-made-real'), 'real_seed_cohort', 50)
    const real = runScorerCli(realRoot)
    assert.equal(real.status, 0, `${real.stderr}\n${real.stdout}`)
    const realSummary = JSON.parse(real.stdout) as { business_pass: boolean }
    assert.equal(realSummary.business_pass, true, 'red baseline: the scorer alone accepts fabricated real evidence')
    // The same bytes labelled synthetic are rejected — so only the label is load-bearing,
    // and only the attestation can prove the label was not flipped after the fact.
    const synthRoot = writeHandMadeEvidenceRoot(join(newRoot(), 'hand-made-synthetic'), 'synthetic_fixture', 50)
    const synth = runScorerCli(synthRoot)
    assert.equal(synth.status, 0, `${synth.stderr}\n${synth.stdout}`)
    assert.equal((JSON.parse(synth.stdout) as { business_pass: boolean }).business_pass, false)
    // A hand-made root carries no attestation at all, which the verifier refuses.
    expectCode('export_validation_failed', () => verifyExportedEvidence(realRoot))
  })

  await pass('(d) relabelling a synthetic export as real breaks the attestation', () => {
    const root = newRoot()
    const clock = stepClock()
    initM3Cohort(initArgs(root, 'synthetic_fixture'), clock)
    captureOne(root, 'synthetic_fixture', 'sim-one', clock)
    const evidenceRoot = join(root, 'evidence')
    exportM3Cohort({ ...common(root), evidenceRoot }, clock)
    const verified = verifyExportedEvidence(evidenceRoot)
    assert.equal(verified.evidence_kind, 'synthetic_fixture')
    assert.equal(verified.simulated_record_count, 1)

    const manifestPath = join(evidenceRoot, 'manifest.json')
    const original = readFileSync(manifestPath, 'utf8')
    writeFileSync(manifestPath, original.replace('"synthetic_fixture"', '"real_seed_cohort"'), 'utf8')
    // Red baseline for this falsification: the scorer trusts the manifest it is handed, so
    // the one-field edit alone is enough to make it report a real cohort.
    const relabelled = runScorerCli(evidenceRoot)
    assert.equal(relabelled.status, 0, `${relabelled.stderr}\n${relabelled.stdout}`)
    assert.equal((JSON.parse(relabelled.stdout) as { evidence_kind: string }).evidence_kind, 'real_seed_cohort')
    // The attestation catches it: the manifest digest no longer matches.
    expectCode('export_validation_failed', () => verifyExportedEvidence(evidenceRoot))
    writeFileSync(manifestPath, original, 'utf8')
    assert.equal(verifyExportedEvidence(evidenceRoot).evidence_kind, 'synthetic_fixture', 'restoring the byte restores the proof')

    // Hiding the synthetic label by deleting the sidecar is caught too.
    const provenancePath = join(evidenceRoot, 'provenance.jsonl')
    const provenance = readFileSync(provenancePath, 'utf8')
    writeFileSync(provenancePath, '', 'utf8')
    expectCode('export_validation_failed', () => verifyExportedEvidence(evidenceRoot))
    writeFileSync(provenancePath, provenance, 'utf8')

    // Editing a cohort record is caught; a legitimate nightly append is not.
    const cohortPath = join(evidenceRoot, 'cohort.jsonl')
    const cohortBytes = readFileSync(cohortPath, 'utf8')
    writeFileSync(cohortPath, cohortBytes.replace('"nps_score":10', '"nps_score":9'), 'utf8')
    expectCode('export_validation_failed', () => verifyExportedEvidence(evidenceRoot))
    writeFileSync(cohortPath, cohortBytes, 'utf8')
    const nightlyLine = JSON.stringify({
      schema_version: 'gotry_m3_nightly_run_v1',
      run_key: `hmac-sha256:${'e'.repeat(64)}`,
      executed_at: '2026-11-05T00:00:00.000Z',
      real_llm: true,
      prompt_set_sha256: 'f'.repeat(64),
      output_sha256: '9'.repeat(64),
      cost_usd: 0.12,
    })
    writeFileSync(cohortPath, `${cohortBytes}${nightlyLine}\n`, 'utf8')
    assert.equal(verifyExportedEvidence(evidenceRoot).record_count, 1, 'a nightly append must not invalidate the cohort attestation')
    assert.equal(cohortRecordLines(readFileSync(cohortPath, 'utf8')).length, 1)
  })

  await pass('(b) a synthetic export refuses to enter an evidence root attested as real', () => {
    const realRoot = newRoot()
    const realClock = stepClock()
    initM3Cohort(initArgs(realRoot, 'real_seed_cohort'), realClock)
    captureOne(realRoot, 'real_seed_cohort', 'real-one', realClock)
    const evidenceRoot = join(realRoot, 'shared-evidence')
    exportM3Cohort({ ...common(realRoot), evidenceRoot }, realClock)

    const simRoot = newRoot()
    const simClock = stepClock()
    initM3Cohort(initArgs(simRoot, 'synthetic_fixture'), simClock)
    captureOne(simRoot, 'synthetic_fixture', 'sim-one', simClock)
    expectCode('evidence_root_conflict', () => exportM3Cohort({ ...common(simRoot), evidenceRoot }, simClock))
    assert.equal(verifyExportedEvidence(evidenceRoot).evidence_kind, 'real_seed_cohort', 'the real root is untouched')
    assert.equal(verifyExportedEvidence(evidenceRoot).simulated_record_count, 0)
  })

  await pass('export refuses a store whose manifest kind no longer matches its records', () => {
    const root = newRoot()
    const clock = stepClock()
    initM3Cohort(initArgs(root, 'synthetic_fixture'), clock)
    captureOne(root, 'synthetic_fixture', 'sim-one', clock)
    const { manifest, events } = readStoreForTests(root)
    const tampered = { ...manifest, evidence_manifest: { ...manifest.evidence_manifest, evidence_kind: 'real_seed_cohort' as const } }
    expectCode('simulation_forbidden_in_real_cohort', () => buildExportPayload(tampered, events, '2026-11-01T00:00:00.000Z'))
  })

  await pass('export is deterministic for the same capture log', () => {
    const root = newRoot()
    const clock = stepClock()
    initM3Cohort(initArgs(root, 'synthetic_fixture'), clock)
    captureOne(root, 'synthetic_fixture', 'sim-b', clock)
    captureOne(root, 'synthetic_fixture', 'sim-a', clock)
    const { manifest, events } = readStoreForTests(root)
    const first = buildExportPayload(manifest, events, '2026-11-01T00:00:00.000Z')
    const second = buildExportPayload(manifest, events, '2026-11-01T00:00:00.000Z')
    assert.equal(canonicalJson(first), canonicalJson(second))
    const keys = first.cohort.map(record => record.plan_key)
    assert.deepEqual(keys, [...keys].sort(), 'records are emitted in plan-key order')
  })

  await pass('CLI: closed error codes, no --at flag, unknown flags refused', () => {
    const root = newRoot()
    const bad = runCli(['init', '--state-root', root, '--consent', CONSENT, '--cohort', 'c', '--evidence-kind', 'synthetic_fixture',
      '--window-start', WINDOW_START, '--window-end', WINDOW_END, '--timezone', 'Asia/Shanghai', '--attribution', 'gotry_primary', '--at', '2026-10-05T00:00:00.000Z'])
    assert.equal(bad.status, 2)
    assert.equal(bad.stdout, '')
    assert.equal(bad.stderr.trim(), 'm3_cohort_error:bad_args')
    const noKey = runCli(['init', '--state-root', root, '--consent', CONSENT, '--cohort', 'c', '--evidence-kind', 'synthetic_fixture',
      '--window-start', WINDOW_START, '--window-end', WINDOW_END, '--timezone', 'Asia/Shanghai', '--attribution', 'gotry_primary'], null)
    assert.equal(noKey.stderr.trim(), 'm3_cohort_error:missing_hmac_key')
    assert.equal(existsSync(storeRootForStateRoot(root)), false)
  })

  await pass('CLI: full real_seed_cohort funnel, export verification and scorer summary', () => {
    const root = newRoot()
    const base = ['--state-root', root, '--consent', CONSENT]
    const init = runCli(['init', ...base, '--cohort', 'm3-seed', '--evidence-kind', 'real_seed_cohort',
      '--window-start', WINDOW_START, '--window-end', WINDOW_END, '--timezone', 'Asia/Shanghai', '--attribution', 'gotry_primary'])
    assert.equal(init.status, 0, `${init.stderr}\n${init.stdout}`)
    for (const args of [
      ['enroll', ...base, '--participant', 'cli-one', '--invited', '--participant-consent'],
      ['deliver', ...base, '--participant', 'cli-one', '--plan', 'cli-one-plan', '--attribution', 'gotry_primary'],
      ['finalize', ...base, '--participant', 'cli-one', '--plan', 'cli-one-plan'],
      ['nps', ...base, '--participant', 'cli-one', '--plan', 'cli-one-plan', '--score', '9'],
      ['poi-lock', ...base, '--participant', 'cli-one', '--plan', 'cli-one-plan', '--locked-claims', '12', '--invalid-claims', '0'],
    ]) {
      const run = runCli(args)
      assert.equal(run.status, 0, `${args[0]}: ${run.stderr}\n${run.stdout}`)
      assert.equal((JSON.parse(run.stdout) as { status: string }).status, 'recorded')
    }
    const evidenceRoot = join(root, 'cli-evidence')
    const exported = runCli(['export', ...base, '--evidence-root', evidenceRoot])
    assert.equal(exported.status, 0, `${exported.stderr}\n${exported.stdout}`)
    const result = JSON.parse(exported.stdout) as {
      record_count: number
      simulated_record_count: number
      verification: { evidence_kind: string }
      scorer_summary: { business_pass: boolean; business_pass_reason: string }
    }
    assert.equal(result.record_count, 1)
    assert.equal(result.simulated_record_count, 0)
    assert.equal(result.verification.evidence_kind, 'real_seed_cohort')
    assert.equal(result.scorer_summary.business_pass, false)
    const verify = runCli(['verify', '--evidence-root', evidenceRoot])
    assert.equal(verify.status, 0, `${verify.stderr}\n${verify.stdout}`)
    assert.equal((JSON.parse(verify.stdout) as { ok: boolean }).ok, true)
    assert.equal(allFileText(evidenceRoot).includes('cli-one'), false, 'raw participant handles never reach the evidence root')
  })

  await pass('CLI: simulated enrolment requires the whole provenance block', () => {
    const root = newRoot()
    const base = ['--state-root', root, '--consent', CONSENT]
    const init = runCli(['init', ...base, '--cohort', 'sim', '--evidence-kind', 'synthetic_fixture',
      '--window-start', WINDOW_START, '--window-end', WINDOW_END, '--timezone', 'Asia/Shanghai', '--attribution', 'gotry_primary'])
    assert.equal(init.status, 0, init.stderr)
    const partial = runCli(['enroll', ...base, '--participant', 'sim-one', '--invited', '--participant-consent', '--simulated', '--persona-id', 'erhai-weekend-unwind'])
    assert.equal(partial.stderr.trim(), 'm3_cohort_error:invalid_input')
    const badDigest = runCli(['enroll', ...base, '--participant', 'sim-one', '--invited', '--participant-consent', '--simulated',
      '--persona-id', 'erhai-weekend-unwind', '--product-model', 'MiniMax-M2', '--persona-model', 'MiniMax-M2', '--prompt-digest', 'not-a-digest'])
    assert.equal(badDigest.stderr.trim(), 'm3_cohort_error:invalid_input')
    const ok = runCli(['enroll', ...base, '--participant', 'sim-one', '--invited', '--participant-consent', '--simulated',
      '--persona-id', 'erhai-weekend-unwind', '--product-model', 'MiniMax-M2', '--persona-model', 'MiniMax-M2', '--prompt-digest', DIGEST])
    assert.equal(ok.status, 0, `${ok.stderr}\n${ok.stdout}`)
    const unlabelled = runCli(['enroll', ...base, '--participant', 'sim-two', '--invited', '--participant-consent'])
    assert.equal(unlabelled.stderr.trim(), 'm3_cohort_error:simulation_label_required')
  })

  console.log(`M3 cohort capture tests: ${n} checks OK`)
}

try {
  await main()
} finally {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
}
