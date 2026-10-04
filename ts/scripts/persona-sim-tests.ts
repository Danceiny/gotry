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
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  CONTRADICTION_KINDS,
  DEFAULT_DECK_PATH,
  deliveredPlanMarkdown,
  loadPersonaDeck,
  parsePersonaDeck,
  PersonaSimError,
  personaSystemPrompt,
  poiAuditFromGateReport,
  promptDigest,
  runPersonaBatch,
  type PersonaCard,
  type PersonaSimErrorCode,
} from './persona-sim.ts'
import { verifyExportedEvidence, type Clock } from '../src/m3-cohort.ts'
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

/** Only 127.0.0.1 may be contacted anywhere in this suite. */
const contactedHosts: string[] = []
const realFetch = globalThis.fetch
globalThis.fetch = (async (input: Parameters<typeof realFetch>[0], init?: Parameters<typeof realFetch>[1]) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url
  try {
    contactedHosts.push(new URL(url).hostname)
  } catch {
    contactedHosts.push(`unparsable:${String(url).slice(0, 40)}`)
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

    // Capture -> export -> scorer.
    const summary = result.scorer_summary!
    assert.equal(summary.evidence_kind, 'synthetic_fixture')
    assert.equal(summary.business_pass, false)
    assert.equal(summary.business_pass_reason, 'evidence_kind=synthetic_fixture cannot prove business pass')
    const delivered = result.personas.filter(persona => persona.plan_delivered).length
    const finalized = result.personas.filter(persona => persona.finalized).length
    assert.equal(summary.sample.participants, delivered)
    assert.equal(summary.finalization.numerator, finalized)
    assert.equal(summary.finalization.denominator, delivered)
    assert.equal(result.verification!.record_count, delivered)
    assert.equal(result.verification!.simulated_record_count, delivered, 'every synthetic record carries provenance')

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
    assert.equal(verifyExportedEvidence(evidenceRoot).evidence_kind, 'synthetic_fixture')
    dryRunDigest = readFileSync(join(evidenceRoot, 'cohort.jsonl'), 'utf8')
    assert.ok(dryRunDigest.length > 0)
  })

  await pass('the offline dry run is byte-deterministic', async () => {
    const root = newRoot()
    const result = await runPersonaBatch({ dryRun: true, stateRoot: root, clock: frozenClock() })
    const repeat = readFileSync(join(result.evidence_root!, 'cohort.jsonl'), 'utf8')
    assert.equal(repeat, dryRunDigest, 'the same frozen clock must produce the same cohort records')
  })

  await pass('budget gate stops the batch early and reports it', async () => {
    const root = newRoot()
    const result = await runPersonaBatch({ dryRun: true, stateRoot: root, clock: frozenClock(), budgetUsd: 0.000001 })
    assert.equal(result.cost_over_budget, true)
    assert.ok(result.reason?.includes('exceeds GOTRY_PERSONA_BUDGET_USD'))
    assert.equal(result.personas.length, 1, 'the batch must stop after the first over-budget persona')
    assert.ok(result.cost_usd > 0.000001)
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
    assert.equal(result.scorer_summary!.sample.participants, 0, 'an interview-only batch produces no cohort record')
    assert.equal(result.scorer_summary!.finalization.rate, null, 'an empty denominator is unavailable, not 0%')
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
    assert.ok(result.scorer_summary!.sample.participants > 0, 'the sentinel personas must actually reach a plan')
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

  await pass('claim audit maps contradictions to invalid and unverified to unverified', () => {
    const unverified = poiAuditFromGateReport({
      verdict: 'blocked',
      claims_checked: 7,
      traceable: 0,
      presentation: 'verified_label_forbidden',
      violations: Array.from({ length: 7 }, () => ({ kind: 'route_unqueried' })),
    })
    assert.equal(unverified.locked_claims, 7)
    assert.equal(unverified.invalid_claims, 0, 'unverified is not hallucinated')
    assert.equal(unverified.unverified_claims, 7)
    assert.equal(unverified.gate_verdict, 'blocked')

    const contradicted = poiAuditFromGateReport({
      verdict: 'blocked',
      claims_checked: 4,
      traceable: 1,
      presentation: 'verified_label_forbidden',
      violations: [{ kind: 'not_in_source' }, { kind: 'contradicted' }, { kind: 'route_unqueried' }],
    })
    assert.equal(contradicted.invalid_claims, 2)
    assert.equal(contradicted.unverified_claims, 1)
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
