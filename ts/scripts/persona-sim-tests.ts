/**
 * LLM-persona simulation harness tests (issue #22).
 *
 * Everything here runs offline and deterministically: both the product model and the
 * persona model are served by a local fixture OpenAI-compatible endpoint, and a fetch spy
 * asserts that no request in the whole suite leaves 127.0.0.1.
 *
 * Covers: deck contract, the no-credential stop rule (zero spend, zero writes), the full
 * offline pipeline (session -> delivered plan -> finalize -> NPS -> fact-gate claim lock ->
 * m3-cohort records -> scorer), byte determinism, synthetic labelling, the budget gate,
 * fail-closed pricing, bounded turns and owned-temp cleanup.
 *
 * Run: cd ts && npx tsx scripts/persona-sim-tests.ts
 */

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  CONTRADICTION_KINDS,
  DEFAULT_DECK_PATH,
  deliveredPlanMarkdown,
  FIXTURE_HMAC_KEY,
  loadPersonaDeck,
  parsePersonaDeck,
  PersonaSimError,
  personaSystemPrompt,
  poiAuditFromGateReport,
  promptDigest,
  runPersonaBatch,
  scrubSessionEnv,
  summarizeFunnel,
  type PersonaCard,
  type PersonaSimErrorCode,
} from './persona-sim.ts'
import {
  enrollParticipant,
  exportM3Cohort,
  initM3Cohort,
  recordNps,
  recordPlanDelivered,
  recordPlanFinalized,
  recordPoiLock,
  verifyExportedEvidence,
  type Clock,
} from '../src/m3-cohort.ts'
import type { TripState } from '../src/contracts.ts'

const __dirname = dirname(fileURLToPath(import.meta.url))
const TS_ROOT = resolve(__dirname, '..')
const TSX = join(TS_ROOT, 'node_modules', '.bin', process.platform === 'win32' ? 'tsx.cmd' : 'tsx')
const SENTINEL = 'PRIVACY_SENTINEL_PERSONA@example.com'
const FROZEN_CLOCK = '2026-10-05T00:00:00.000Z'

const roots: string[] = []
function newRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'gotry-persona-tests-'))
  roots.push(root)
  return root
}

function frozenClock(): Clock {
  let ms = Date.parse(FROZEN_CLOCK)
  return { now: () => { ms += 1_000; return new Date(ms) } }
}

let n = 0
async function pass(name: string, body: () => void | Promise<void>): Promise<void> {
  await body()
  console.log(`  ${++n}. ${name} OK`)
}

async function expectCode(code: PersonaSimErrorCode, body: () => Promise<unknown>): Promise<void> {
  try {
    await body()
  } catch (error) {
    assert.ok(error instanceof PersonaSimError, `expected PersonaSimError, got ${String(error)}`)
    assert.equal(error.code, code, error.message)
    return
  }
  assert.fail(`expected PersonaSimError ${code}`)
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

function withEnv<T>(patch: Record<string, string | undefined>, body: () => T): T {
  const saved = new Map<string, string | undefined>()
  for (const [key, value] of Object.entries(patch)) {
    saved.set(key, process.env[key])
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  try {
    return body()
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

/** Like withEnv, but the environment stays patched until the async body settles. */
async function withEnvAsync<T>(patch: Record<string, string | undefined>, body: () => Promise<T>): Promise<T> {
  const saved = new Map<string, string | undefined>()
  for (const [key, value] of Object.entries(patch)) {
    saved.set(key, process.env[key])
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  try {
    return await body()
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

/**
 * Only 127.0.0.1 may be contacted anywhere in this suite, and the spy ENFORCES it rather
 * than recording it: a regression that reached a live endpoint would carry whatever
 * LLM_API_KEY the operator has exported, so the request must never leave the process.
 */
const contactedHosts: string[] = []
const realFetch = globalThis.fetch
globalThis.fetch = (async (input: Parameters<typeof realFetch>[0], init?: Parameters<typeof realFetch>[1]) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url
  let hostname: string
  try {
    hostname = new URL(url).hostname
  } catch {
    hostname = `unparsable:${String(url).slice(0, 40)}`
  }
  contactedHosts.push(hostname)
  if (hostname !== '127.0.0.1') {
    throw new Error(`offline test suite attempted a request to ${hostname} — blocked before any credential could leave`)
  }
  return realFetch(input, init)
}) as typeof realFetch

function writeDeck(root: string, personas: PersonaCard[], description = 'test deck'): string {
  const path = join(root, 'deck.json')
  writeFileSync(path, JSON.stringify({ schema_version: 'gotry_persona_sim_deck_v1', description, personas }, null, 2), 'utf8')
  return path
}

function baseCard(overrides: Partial<PersonaCard> & { persona_id: string }): PersonaCard {
  return {
    title: 'test persona',
    grounding: 'test only',
    goals: ['go somewhere'],
    hard_constraints: ['nothing booked yet'],
    patience: { max_user_turns: 3, abandon_after_questions: 3 },
    answering_style: 'terse',
    finalize_rule: 'finalize at the first plan',
    rating_rule: 'rate 8',
    opening_message: '帮我规划一下。',
    expected_outcome: 'interview_only',
    dry_run: {
      product_facts: [{}],
      product_skeleton: null,
      product_slots: null,
      persona_turns: [{ decision: 'continue', message: '继续。' }],
    },
    ...overrides,
  }
}

async function main(): Promise<void> {
  console.log('persona-sim tests')

  await pass('the shipped deck satisfies the closed card contract', () => {
    const deck = loadPersonaDeck()
    assert.ok(deck.length >= 6, `deck needs at least 6 personas, got ${deck.length}`)
    assert.deepEqual(deck.map(card => card.persona_id), [...deck.map(card => card.persona_id)].sort(), 'deck order is deterministic')
    assert.equal(new Set(deck.map(card => card.persona_id)).size, deck.length)
    // Diversity is part of the contract: a deck that is all one style or all one outcome
    // cannot exercise the funnel branches.
    assert.ok(new Set(deck.map(card => card.answering_style)).size >= 2)
    assert.deepEqual(
      [...new Set(deck.map(card => card.expected_outcome))].sort(),
      ['interview_only', 'plan_delivered_and_finalized', 'plan_delivered_not_finalized'],
      'the deck must cover finalize, no-finalize and interview-only outcomes',
    )
    for (const card of deck) {
      assert.match(promptDigest(card), /^[0-9a-f]{64}$/)
      assert.ok(personaSystemPrompt(card).includes(card.persona_id))
      assert.ok(personaSystemPrompt(card).includes('You are a simulation, not a real traveller') || personaSystemPrompt(card).includes('simulation, not a real traveller'))
    }
  })

  await pass('deck mutations are refused fail-closed', () => {
    const raw = JSON.parse(readFileSync(DEFAULT_DECK_PATH, 'utf8')) as Record<string, unknown>
    const mutate = (fn: (deck: Record<string, unknown>) => void): void => {
      const copy = JSON.parse(JSON.stringify(raw)) as Record<string, unknown>
      fn(copy)
      assert.throws(() => parsePersonaDeck(copy), (error: unknown) => {
        assert.ok(error instanceof PersonaSimError)
        assert.equal(error.code, 'invalid_persona_deck')
        return true
      })
    }
    mutate(deck => { (deck['personas'] as unknown[]).length = 5 })
    mutate(deck => { deck['schema_version'] = 'gotry_persona_sim_deck_v2' })
    mutate(deck => { (deck['personas'] as Array<Record<string, unknown>>)[0]!['persona_id'] = 'Not A Valid Id' })
    mutate(deck => { (deck['personas'] as Array<Record<string, unknown>>)[1]!['persona_id'] = (deck['personas'] as Array<Record<string, unknown>>)[0]!['persona_id'] })
    mutate(deck => { (deck['personas'] as Array<Record<string, unknown>>)[0]!['surprise'] = 'extra field' })
    mutate(deck => { delete (deck['personas'] as Array<Record<string, unknown>>)[0]!['finalize_rule'] })
    mutate(deck => { (deck['personas'] as Array<Record<string, unknown>>)[0]!['answering_style'] = 'sarcastic' })
    mutate(deck => {
      const dryRun = (deck['personas'] as Array<Record<string, unknown>>)[0]!['dry_run'] as Record<string, unknown>
      ;(dryRun['persona_turns'] as Array<Record<string, unknown>>)[0] = { decision: 'continue' }
    })
    mutate(deck => {
      const dryRun = (deck['personas'] as Array<Record<string, unknown>>)[0]!['dry_run'] as Record<string, unknown>
      ;(dryRun['persona_turns'] as Array<Record<string, unknown>>)[0] = { decision: 'abandon', nps: 11 }
    })
  })

  await pass('no credential and no --dry-run: waiting_external_evidence, zero writes, zero spend', async () => {
    const root = newRoot()
    const evidenceRoot = join(root, 'evidence')
    const before = contactedHosts.length
    const result = await withEnv({ LLM_API_KEY: undefined, DEEPSEEK_API_KEY: undefined }, () => runPersonaBatch({
      dryRun: false,
      stateRoot: root,
      evidenceRoot,
      clock: frozenClock(),
    }))
    assert.equal(result.state, 'waiting_external_evidence')
    assert.equal(result.real_llm, false)
    assert.equal(result.cost_usd, 0)
    assert.equal(result.real_spend_usd, 0)
    assert.equal(result.personas.length, 0)
    assert.equal(result.evidence_root, null)
    assert.equal(result.scorer_summary, null)
    assert.equal(existsSync(evidenceRoot), false, 'the waiting state must write nothing')
    assert.equal(existsSync(join(root, 'capture')), false)
    assert.equal(contactedHosts.length, before, 'the waiting state must contact nothing')
  })

  await pass('a real batch must name both roots so its paid evidence survives', async () => {
    const before = contactedHosts.length
    await expectCode('bad_args', async () => withEnv({ LLM_API_KEY: 'placeholder-never-used', GOTRY_PERSONA_CONSENT: 'test', GOTRY_M3_COHORT_HMAC_KEY: '0123456789abcdef0123456789abcdef' }, () => runPersonaBatch({
      dryRun: false,
      clock: frozenClock(),
    })))
    await expectCode('bad_args', async () => withEnv({ LLM_API_KEY: 'placeholder-never-used', GOTRY_PERSONA_CONSENT: 'test', GOTRY_M3_COHORT_HMAC_KEY: '0123456789abcdef0123456789abcdef' }, () => runPersonaBatch({
      dryRun: false,
      stateRoot: newRoot(),
      clock: frozenClock(),
    })))
    assert.equal(contactedHosts.length, before, 'the guard must run before any request')
  })

  let dryRunDigest = ''
  await pass('offline dry run drives the whole pipeline through to the scorer', async () => {
    const root = newRoot()
    const result = await runPersonaBatch({ dryRun: true, stateRoot: root, clock: frozenClock() })
    assert.equal(result.state, 'dry_run_complete')
    assert.equal(result.evidence_kind, 'synthetic_fixture')
    assert.equal(result.real_llm, false)
    assert.equal(result.real_spend_usd, 0)
    assert.ok(result.cost_usd > 0, 'the price path must be exercised even though nothing is spent')
    const deck = loadPersonaDeck()
    assert.equal(result.personas.length, deck.length)

    // Every card's own declared outcome must be what the pipeline produced.
    for (const persona of result.personas) {
      const card = deck.find(item => item.persona_id === persona.persona_id)!
      assert.equal(persona.error, null, `${persona.persona_id}: ${JSON.stringify(persona.error)}`)
      assert.ok(persona.user_turns >= 1 && persona.user_turns <= card.patience.max_user_turns)
      if (card.expected_outcome === 'interview_only') {
        assert.equal(persona.plan_delivered, false, `${persona.persona_id} must stay in the interview`)
        assert.equal(persona.poi_audit, null)
      } else {
        assert.equal(persona.plan_delivered, true, `${persona.persona_id} must receive a plan`)
        assert.ok(persona.poi_audit, 'a delivered plan must carry a claim audit')
        assert.match(persona.plan_markdown_sha256!, /^[0-9a-f]{64}$/)
      }
      assert.equal(persona.finalized, card.expected_outcome === 'plan_delivered_and_finalized')
    }

    // The fixture classified every product prompt: an unclassified one means src/dsh-llm.ts
    // changed its system prompts and the harness is no longer driving the real seam.
    const calls = result.fixture_calls!
    assert.equal(calls['unclassified'], 0, `fixture could not classify a product prompt: ${JSON.stringify(calls)}`)
    for (const kind of ['facts', 'skeleton', 'slots', 'polish', 'persona']) {
      assert.ok((calls[kind] ?? 0) > 0, `fixture never served a ${kind} call: ${JSON.stringify(calls)}`)
    }

    // Capture -> export -> scorer. Every simulated participant is enrolled
    // test_or_staff=true, so the scorer excludes all of them at record level: its eligible
    // set is empty and its funnel fields are unavailable, which is the point.
    const summary = result.scorer_summary!
    assert.equal(summary.evidence_kind, 'synthetic_fixture')
    assert.equal(summary.business_pass, false)
    assert.equal(summary.business_pass_reason, 'evidence_kind=synthetic_fixture cannot prove business pass')
    const delivered = result.personas.filter(persona => persona.plan_delivered).length
    const finalized = result.personas.filter(persona => persona.finalized).length
    assert.equal(summary.sample.participants, 0, 'no simulated participant may enter the eligible set')
    assert.equal(summary.exclusions['test_or_staff'], delivered, 'every simulated record is excluded as test_or_staff')
    assert.equal(summary.finalization.rate, null, 'an empty eligible set is unavailable, never 0%')
    assert.equal(summary.nps.score, null)
    assert.equal(summary.poi_hallucination.rate, null)
    assert.equal(result.verification!.record_count, delivered)
    assert.equal(result.verification!.simulated_record_count, delivered, 'every synthetic record carries provenance')

    // The funnel a reader wants is computed by the harness over its own outcomes.
    const funnel = result.funnel
    assert.equal(funnel.schema, 'gotry_persona_sim_funnel.v1')
    assert.equal(funnel.personas_run, deck.length)
    assert.equal(funnel.delivered, delivered)
    assert.equal(funnel.finalized, finalized)
    assert.equal(funnel.finalization_rate, Number((finalized / delivered).toFixed(6)))
    assert.equal(funnel.errored, 0)
    const scores = result.personas.filter(persona => persona.plan_delivered && persona.nps !== null).map(persona => persona.nps!)
    assert.equal(funnel.nps_responses, scores.length)
    assert.equal(funnel.promoters, scores.filter(score => score >= 9).length)
    assert.equal(funnel.detractors, scores.filter(score => score <= 6).length)
    // With an empty fact registry nothing is adjudicable, so the audited denominator is 0
    // and the POI rate is unavailable rather than a flattering 0%.
    assert.ok(funnel.claims_extracted > 0, 'the gate must have extracted claims from the plans')
    assert.equal(funnel.locked_claims, 0, 'an empty registry can audit nothing')
    assert.equal(funnel.invalid_claims, 0)
    assert.equal(funnel.poi_rate, null, 'nothing audited means unavailable, not 0%')

    // The exported provenance must name the persona and digest the prompt that drove it.
    const evidenceRoot = result.evidence_root!
    const provenance = readFileSync(join(evidenceRoot, 'provenance.jsonl'), 'utf8')
      .split('\n').filter(line => line.trim() !== '').map(line => JSON.parse(line) as Record<string, unknown>)
    assert.equal(provenance.length, delivered)
    for (const row of provenance) {
      assert.equal(row['kind'], 'llm_persona')
      const card = deck.find(item => item.persona_id === row['persona_id'])!
      assert.equal(row['prompt_digest'], promptDigest(card))
      assert.equal(row['product_model'], result.product_model)
      assert.equal(row['persona_model'], result.persona_model)
    }
    assert.equal(verifyExportedEvidence(evidenceRoot, FIXTURE_HMAC_KEY).evidence_kind, 'synthetic_fixture')
    for (const record of readFileSync(join(evidenceRoot, 'cohort.jsonl'), 'utf8')
      .split('\n').filter(line => line.trim() !== '').map(line => JSON.parse(line) as Record<string, unknown>)) {
      assert.equal(record['test_or_staff'], true, 'every simulated record must be labelled test_or_staff')
      assert.equal((record['poi_audit'] as Record<string, unknown>)['locked_claims'], 0)
    }
    dryRunDigest = readFileSync(join(evidenceRoot, 'cohort.jsonl'), 'utf8')
    assert.ok(dryRunDigest.length > 0)
  })

  await pass('evidence_kind alone still blocks business_pass when records are not test_or_staff', async () => {
    // The record-level exclusion is one half of the guarantee; this proves the other half
    // independently, by scoring a synthetic manifest over records that are NOT excluded.
    const root = newRoot()
    const evidenceRoot = join(root, 'not-excluded')
    const clock = frozenClock()
    const captureRoot = join(root, 'capture')
    const captureCommon = { stateRoot: captureRoot, consent: 'test consent', hmacKey: '0123456789abcdef0123456789abcdef' }
    const simulation = {
      schema_version: 'gotry_m3_simulation_provenance_v1' as const,
      kind: 'llm_persona' as const,
      persona_id: 'erhai-weekend-unwind',
      product_model: 'MiniMax-M2',
      persona_model: 'MiniMax-M2',
      prompt_digest: 'a'.repeat(64),
    }
    initM3Cohort({
      ...captureCommon,
      cohort: 'not-excluded',
      evidenceKind: 'synthetic_fixture',
      windowStartAt: '2026-10-01T00:00:00.000Z',
      windowEndAt: '2026-12-31T23:59:59.000Z',
      timezone: 'UTC',
      allowedAttribution: ['gotry_primary'],
    }, clock)
    for (let index = 0; index < 50; index += 1) {
      const participant = `sim-${String(index).padStart(3, '0')}`
      const plan = `${participant}-plan`
      enrollParticipant({ ...captureCommon, participant, invited: true, participantConsent: true, testOrStaff: false, simulation }, clock)
      recordPlanDelivered({ ...captureCommon, participant, plan, attribution: 'gotry_primary' }, clock)
      recordPlanFinalized({ ...captureCommon, participant, plan }, clock)
      recordNps({ ...captureCommon, participant, plan, score: 10 }, clock)
      recordPoiLock({ ...captureCommon, participant, plan, lockedClaims: 10, invalidClaims: 0 }, clock)
    }
    const { payload } = exportM3Cohort({ ...captureCommon, evidenceRoot }, clock)
    assert.equal(payload.cohort.length, 50)
    assert.equal(payload.cohort.every(record => record.test_or_staff === false), true)
    const scorer = spawnSync(TSX, ['scripts/product-metrics.ts', '--evidence-root', evidenceRoot, '--format', 'json'], {
      cwd: TS_ROOT, encoding: 'utf8', timeout: 120_000,
    })
    assert.equal(scorer.status, 0, `${scorer.stderr}\n${scorer.stdout}`)
    const summary = JSON.parse(scorer.stdout) as { sample: { participants: number; pass: boolean }; business_pass: boolean; business_pass_reason: string }
    assert.equal(summary.sample.participants, 50, 'these records DO enter the eligible set')
    assert.equal(summary.sample.pass, true)
    assert.equal(summary.business_pass, false, 'evidence_kind alone must still block business_pass')
    assert.equal(summary.business_pass_reason, 'evidence_kind=synthetic_fixture cannot prove business pass')
  })

  await pass('the offline dry run is byte-deterministic', async () => {
    const root = newRoot()
    const result = await runPersonaBatch({ dryRun: true, stateRoot: root, clock: frozenClock() })
    const repeat = readFileSync(join(result.evidence_root!, 'cohort.jsonl'), 'utf8')
    assert.equal(repeat, dryRunDigest, 'the same frozen clock must produce the same cohort records')
  })

  await pass('budget gate trips between turns, stops the batch and still exports the spend', async () => {
    const root = newRoot()
    const result = await runPersonaBatch({ dryRun: true, stateRoot: root, clock: frozenClock(), budgetUsd: 0.000001 })
    assert.equal(result.cost_over_budget, true)
    assert.ok(result.reason?.includes('exceeds GOTRY_PERSONA_BUDGET_USD'))
    assert.equal(result.personas.length, 1, 'the batch must stop after the first over-budget persona')
    assert.ok(result.cost_usd > 0.000001)
    // The first session is cut mid-flight rather than being allowed to run to completion.
    assert.equal(result.personas[0]!.error?.code, 'budget_exceeded')
    // The already-paid spend is still exported: the records are facts about money spent.
    assert.ok(result.evidence_root && existsSync(result.evidence_root), 'an over-budget batch still writes its evidence')
    assert.equal(verifyExportedEvidence(result.evidence_root!, FIXTURE_HMAC_KEY).ok, true)
  })

  await pass('an unsafe --state-root is refused before any directory is created', async () => {
    const forbidden = join(TS_ROOT, 'dsh-runtime', 'persona-sim-should-never-exist')
    assert.equal(existsSync(forbidden), false, 'precondition: the forbidden path must not exist yet')
    await expectCode('unsafe_state_root', async () => runPersonaBatch({
      dryRun: true,
      stateRoot: forbidden,
      evidenceRoot: join(forbidden, 'evidence'),
      clock: frozenClock(),
    }))
    assert.equal(existsSync(forbidden), false, 'the harness must not mkdir inside a forbidden state root')
    assert.equal(existsSync(join(forbidden, 'empty-bin')), false)
    assert.equal(existsSync(join(forbidden, 'capture')), false)
  })

  await pass('the funnel summary is pure and never divides by an empty denominator', () => {
    const empty = summarizeFunnel([])
    assert.equal(empty.delivered, 0)
    assert.equal(empty.finalization_rate, null)
    assert.equal(empty.nps_score, null)
    assert.equal(empty.poi_rate, null)
  })

  await pass('an unpriced model is refused before any spend', async () => {
    const root = newRoot()
    const evidenceRoot = join(root, 'evidence')
    const before = contactedHosts.length
    await expectCode('missing_price_entry', async () => withEnv({ LLM_MODEL: 'model-with-no-sealed-price' }, () => runPersonaBatch({
      dryRun: true,
      stateRoot: root,
      evidenceRoot,
      clock: frozenClock(),
    })))
    assert.equal(existsSync(evidenceRoot), false)
    assert.equal(contactedHosts.length, before, 'the price gate must run before the first request')
  })

  await pass('a provider that omits usage makes cost unprovable: fail-closed', async () => {
    const root = newRoot()
    const evidenceRoot = join(root, 'evidence')
    await expectCode('cost_unprovable', async () => runPersonaBatch({
      dryRun: true,
      stateRoot: root,
      evidenceRoot,
      clock: frozenClock(),
      omitFixtureUsage: true,
      personaFilter: ['phuket-workation-multileg'],
    }))
    assert.equal(existsSync(evidenceRoot), false, 'no evidence may be written when cost is unprovable')
  })

  await pass('turn count is bounded by the card patience even when the persona never stops', async () => {
    const root = newRoot()
    const deckPath = writeDeck(root, Array.from({ length: 6 }, (_unused, index) => baseCard({
      persona_id: `endless-${index}`,
      patience: { max_user_turns: 2, abandon_after_questions: 2 },
      dry_run: {
        product_facts: [{}],
        product_skeleton: null,
        product_slots: null,
        persona_turns: [{ decision: 'continue', message: '再说说。' }],
      },
    })))
    const result = await runPersonaBatch({ dryRun: true, deckPath, stateRoot: root, clock: frozenClock() })
    assert.equal(result.personas.length, 6)
    for (const persona of result.personas) {
      assert.equal(persona.user_turns, 2, 'the loop must stop at max_user_turns')
      assert.equal(persona.plan_delivered, false)
    }
    assert.equal(result.verification!.record_count, 0, 'an interview-only batch produces no cohort record')
    assert.equal(result.funnel.delivered, 0)
    assert.equal(result.funnel.finalization_rate, null, 'an empty denominator is unavailable, not 0%')
    assert.equal(result.scorer_summary!.sample.participants, 0)
  })

  await pass('a PII sentinel in a persona utterance never reaches the evidence root', async () => {
    const root = newRoot()
    const deckPath = writeDeck(root, Array.from({ length: 6 }, (_unused, index) => baseCard({
      persona_id: `sentinel-${index}`,
      opening_message: `我叫 ${SENTINEL},帮我规划普吉两周的 workation。`,
      expected_outcome: 'plan_delivered_and_finalized',
      dry_run: {
        product_facts: [
          { profile: { workWindow: { vacation: true }, bookedResources: [] } },
        ],
        product_skeleton: { scenario: 'workation', segments: [{ id: 'f1', role: 'choice' }] },
        product_slots: null,
        persona_turns: [{ decision: 'finalize', message: `好的,${SENTINEL}`, nps: 9 }],
      },
    })))
    const result = await runPersonaBatch({ dryRun: true, deckPath, stateRoot: root, clock: frozenClock() })
    assert.ok(result.funnel.delivered > 0, 'the sentinel personas must actually reach a plan')
    const evidenceText = allFileText(result.evidence_root!)
    assert.equal(evidenceText.includes(SENTINEL), false, 'sentinel leaked into the evidence root')
    assert.equal(evidenceText.includes('PRIVACY_SENTINEL'), false)
    assert.equal(allFileText(join(root, 'capture')).includes(SENTINEL), false, 'sentinel leaked into the capture store')
    assert.equal(JSON.stringify(result).includes(SENTINEL), false, 'sentinel leaked into the run summary')
  })

  await pass('an owned temp root is removed; a caller-supplied root is kept', async () => {
    const result = await runPersonaBatch({ dryRun: true, clock: frozenClock(), personaFilter: ['erhai-weekend-unwind'] })
    assert.ok(result.evidence_root)
    assert.equal(existsSync(result.evidence_root!), false, 'an owned batch root must be cleaned up')
    const root = newRoot()
    const kept = await runPersonaBatch({ dryRun: true, stateRoot: root, clock: frozenClock(), personaFilter: ['erhai-weekend-unwind'] })
    assert.equal(existsSync(kept.evidence_root!), true)
  })

  await pass('the audited denominator counts only adjudicable claims', () => {
    // An entirely unverified plan must not look like a clean one: nothing was audited, so
    // the denominator is 0 and the scorer reports unavailable rather than a 0% POI rate.
    const unverified = poiAuditFromGateReport({
      verdict: 'blocked',
      claims_checked: 7,
      traceable: 0,
      presentation: 'verified_label_forbidden',
      violations: Array.from({ length: 7 }, () => ({ kind: 'route_unqueried' })),
    })
    assert.equal(unverified.claims_extracted, 7)
    assert.equal(unverified.locked_claims, 0, 'nothing adjudicable means nothing audited')
    assert.equal(unverified.invalid_claims, 0, 'unverified is not hallucinated')
    assert.equal(unverified.unverified_claims, 7)
    assert.equal(unverified.gate_verdict, 'blocked')

    const mixed = poiAuditFromGateReport({
      verdict: 'blocked',
      claims_checked: 4,
      traceable: 1,
      presentation: 'verified_label_forbidden',
      violations: [{ kind: 'not_in_source' }, { kind: 'contradicted' }, { kind: 'route_unqueried' }],
    })
    assert.equal(mixed.locked_claims, 3, 'one traceable plus two contradicted were adjudicated')
    assert.equal(mixed.invalid_claims, 2)
    assert.equal(mixed.unverified_claims, 1)
    assert.ok(CONTRADICTION_KINDS.has('not_in_source') && !CONTRADICTION_KINDS.has('route_unqueried'))

    const clean = poiAuditFromGateReport({ verdict: 'pass', claims_checked: 3, traceable: 3, presentation: 'verified_itinerary_allowed', violations: [] })
    assert.deepEqual(
      { locked: clean.locked_claims, invalid: clean.invalid_claims, verdict: clean.gate_verdict },
      { locked: 3, invalid: 0, verdict: 'pass' },
    )
  })

  await pass('no plan means no delivered artifact', () => {
    assert.equal(deliveredPlanMarkdown({ calendar: { year: 2026, assertedWeekdays: {} }, profile: {}, gates: [], wishes: [] } as TripState), null)
    assert.equal(deliveredPlanMarkdown({
      calendar: { year: 2026, assertedWeekdays: {} }, profile: {}, gates: [], wishes: [],
      solve: { answer_md: '# 候选对比\n...' },
    } as unknown as TripState), '# 候选对比\n...')
  })

  await pass('CLI: offline dry run exits 0 with a machine-readable synthetic result', () => {
    const run = spawnSync(TSX, ['scripts/persona-sim.ts', '--dry-run', '--format', 'json', '--persona', 'erhai-weekend-unwind'], {
      cwd: TS_ROOT,
      encoding: 'utf8',
      timeout: 300_000,
      env: { ...process.env, LLM_API_KEY: undefined, DEEPSEEK_API_KEY: undefined },
    })
    assert.equal(run.status, 0, `${run.stderr}\n${run.stdout}`)
    const result = JSON.parse(run.stdout) as { state: string; evidence_kind: string; scorer_summary: { business_pass: boolean } }
    assert.equal(result.state, 'dry_run_complete')
    assert.equal(result.evidence_kind, 'synthetic_fixture')
    assert.equal(result.scorer_summary.business_pass, false)
  })

  await pass('session env: GOTRY_HBCLI_LIVE defaults to 0, an explicit operator value is kept, and the env is restored (issue #617)', async () => {
    const sandbox = newRoot()
    for (const [operator, expected] of [[undefined, '0'], ['1', '1'], ['0', '0'], ['off', 'off']] as const) {
      await withEnvAsync({ GOTRY_HBCLI_LIVE: operator }, async () => {
        const restore = scrubSessionEnv({}, sandbox)
        assert.equal(process.env['GOTRY_HBCLI_LIVE'], expected, `operator ${String(operator)} -> sessions see ${expected}`)
        assert.equal(process.env['PATH'], join(sandbox, 'empty-bin'), 'PATH stays scrubbed whatever the operator set')
        assert.equal(process.env['HOME'], sandbox)
        restore()
        assert.equal(process.env['GOTRY_HBCLI_LIVE'], operator, 'the operator value is restored exactly')
      })
    }
  })

  await pass('a dry-run batch never spawns hbcli by default; an explicit operator value is not overridden (issue #617)', async () => {
    // The batch sets HOME=<state root> and PATH=<empty dir>, so the HOME-relative known-install location is the
    // only place the POI probe could ever find a binary. A counting fake lives there (shell builtins only, so it
    // also runs under the empty PATH); the explicit `1` run is the positive control proving it is reachable.
    // Each run gets its own root: a batch refuses to export over an existing evidence directory.
    const batch = async (operator: string | undefined): Promise<{ calls: number; error: unknown; sessions: number }> => {
      const root = newRoot()
      const fakeDir = join(root, '.local', 'bin')
      mkdirSync(fakeDir, { recursive: true })
      const callsLog = join(root, 'hbcli-calls.log')
      writeFileSync(join(fakeDir, 'hbcli'), `#!/bin/sh\nprintf 'call\\n' >> '${callsLog}'\nprintf '%s' '{"candidates":[]}'\n`, { mode: 0o755 })
      // A bare place name is what probePoi turns into an anything search on the first user turn.
      const deckPath = writeDeck(root, Array.from({ length: 6 }, (_unused, index) => baseCard({
        persona_id: `poi-probe-${index}`,
        opening_message: '大理',
      })))
      const result = await withEnvAsync({ GOTRY_HBCLI_LIVE: operator }, async () => {
        const outcome = await runPersonaBatch({ dryRun: true, deckPath, stateRoot: root, clock: frozenClock(), personaFilter: ['poi-probe-0'] })
        assert.equal(process.env['GOTRY_HBCLI_LIVE'], operator, 'the batch restores the operator value')
        return outcome
      })
      const calls = existsSync(callsLog) ? readFileSync(callsLog, 'utf8').split('\n').filter(Boolean).length : 0
      return { calls, error: result.personas[0]?.error ?? null, sessions: result.personas.length }
    }

    const byDefault = await batch(undefined)
    assert.equal(byDefault.sessions, 1)
    assert.equal(byDefault.error, null, 'the probe path must not break the session')
    assert.equal(byDefault.calls, 0, 'default dry-run: the fake hbcli must be invoked ZERO times')

    const explicitOff = await batch('0')
    assert.equal(explicitOff.calls, 0, 'explicit 0 stays offline')

    const explicitOn = await batch('1')
    assert.ok(explicitOn.calls >= 1, `explicit GOTRY_HBCLI_LIVE=1 must not be overridden: the POI probe should reach the fake (calls=${explicitOn.calls})`)
  })

  await pass('the whole suite contacted nothing outside 127.0.0.1', () => {
    assert.ok(contactedHosts.length > 0, 'the fixture provider must actually have been called')
    const offHost = [...new Set(contactedHosts)].filter(host => host !== '127.0.0.1')
    assert.deepEqual(offHost, [], `off-host requests: ${offHost.join(', ')}`)
  })

  console.log(`persona-sim tests: ${n} checks OK (${contactedHosts.length} fixture requests, all 127.0.0.1)`)
}

try {
  await main()
} finally {
  globalThis.fetch = realFetch
  for (const root of roots) rmSync(root, { recursive: true, force: true })
}
