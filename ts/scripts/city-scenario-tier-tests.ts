/**
 * City × scenario tiering MECHANISM tests (issue #339 contract slice,
 * SIMULATED-TRIGGER DRILL — fully offline, zero network, zero state).
 *
 * ⚠ Evidence label: `simulated_trigger_drill` / `fixture_contract`. #339's real
 * trigger (reviewable real usage samples + an explicit scenario vocabulary and
 * success metric) has NOT fired. Every registry used below is a TEST-ONLY shape
 * probe constructed with `{ triggerFired: true }`; its city/scenario strings are
 * deliberately meaningless placeholders (`city-a`, `scenario-x`) so that nothing
 * here can be mistaken for a taxonomy. The product registry stays frozen EMPTY —
 * #339 forbids fabricating a profile from fixtures.
 *
 * Sections:
 *  A. Default-off proof: trigger frozen false, registry frozen empty in SOURCE,
 *     admission refused before any validation, every resolution neutral.
 *  B. Admission shape: mandatory provenance (evidence grade / real sample source /
 *     ≥3 sample refs / reviewer / freeze instant) and retirement (condition +
 *     review deadline postdating the freeze); each omission fail-closed.
 *  C. Bounded modifier: integer ppm inside declared bounds; 0, negative,
 *     out-of-range, float and non-numeric refused — no tier can annihilate a score.
 *  D. Neutral fallback: unknown city, unknown scenario, conflicting evidence,
 *     empty registry; a conflict elects no winner.
 *  E. Ranking-only falsification: a modifier reorders but can NEVER remove a
 *     candidate (incl. lower bound × zero semantic), the result exposes no filter
 *     surface, and the mechanical no-hard-filter check passes.
 *  F. Determinism + versioning: identical inputs → byte-identical output; ties keep
 *     declaration order; a defective registry entry is refused, never clamped.
 *
 * Run (from ts/): npx tsx scripts/city-scenario-tier-tests.ts
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  CITY_SCENARIO_TIER_REGISTRY,
  CITY_SCENARIO_TIER_SCHEMA,
  CITY_SCENARIO_TIER_TRIGGER_FIRED,
  TIER_APPLICATION_SURFACES,
  TIER_EVIDENCE_GRADES,
  TIER_KEY_MAX_CHARS,
  TIER_MIN_SAMPLE_REFS,
  TIER_MODIFIER_PPM_MAX,
  TIER_MODIFIER_PPM_MIN,
  TIER_MODIFIER_PPM_NEUTRAL,
  TIER_NEUTRAL_REASONS,
  TIER_SAMPLE_SOURCES,
  admitTierEntry,
  applyTierRanking,
  normalizeTierKey,
  resolveTier,
  tierRankingFilterViolation,
  type CityScenarioTierEntry,
  type TierErrorCode,
  type TierRankCandidate,
  type TierResult,
} from '../src/city-scenario-tier.ts'

let passed = 0
function check(cond: boolean, msg: string): void {
  if (cond) {
    passed++
    console.log(`  ok - ${msg}`)
  } else {
    console.error(`  FAIL - ${msg}`)
    process.exitCode = 1
  }
}

function expectRefusal<T>(result: TierResult<T>, code: TierErrorCode, needle: string, msg: string): void {
  if (result.ok) {
    check(false, `${msg} (expected refusal ${code}, got ok)`)
    return
  }
  check(
    result.code === code && result.detail.includes(needle),
    `${msg} (refused ${result.code}${result.code === code ? '' : ` ≠ ${code}`}, evidence contains "${needle}": ${result.detail.includes(needle)})`,
  )
}

const FROZEN_AT = '2026-10-04T00:00:00.000Z'
const REVIEW_BY = '2027-04-04T00:00:00.000Z'

/** TEST-ONLY shape probe. The keys are meaningless placeholders, not a taxonomy. */
function probeEntryInput(overrides: Record<string, unknown> = {}): Parameters<typeof admitTierEntry>[0] {
  return {
    tier_id: 'probe-tier-1',
    city_key: 'city-a',
    scenario_key: 'scenario-x',
    modifier_ppm: 1_100_000,
    applies_to: 'ranking',
    provenance: {
      evidence_grade: 'controlled_replay',
      sample_source: 'real_usage_sample',
      sample_refs: ['sample-ref-1', 'sample-ref-2', 'sample-ref-3'],
      reviewer: 'drill-reviewer',
      frozen_at: FROZEN_AT,
    },
    retirement: { condition: 'withdraw if the controlled replay no longer reproduces the ordering', review_by: REVIEW_BY },
    taxonomy_version: 'probe.v0',
    ...overrides,
  } as Parameters<typeof admitTierEntry>[0]
}

function admittedProbe(overrides: Record<string, unknown> = {}, registry: readonly CityScenarioTierEntry[] = []): CityScenarioTierEntry {
  const r = admitTierEntry(probeEntryInput(overrides), { triggerFired: true, registry })
  if (!r.ok) throw new Error(`probe admission failed unexpectedly: ${r.code} ${r.detail}`)
  return r.value
}

// ---------------------------------------------------------------------------
// A. Default-off proof
// ---------------------------------------------------------------------------
console.log('A. default-off: trigger frozen false, registry frozen EMPTY, nothing admitted')
check(CITY_SCENARIO_TIER_TRIGGER_FIRED === false, '#339 trigger gate frozen false')
check(CITY_SCENARIO_TIER_REGISTRY.length === 0, 'the runtime taxonomy registry is empty')
check(CITY_SCENARIO_TIER_SCHEMA === 'gotry_city_scenario_tier.v1', 'the taxonomy schema id is versioned')

const MODULE_SOURCE = readFileSync(join(fileURLToPath(new URL('.', import.meta.url)), '..', 'src', 'city-scenario-tier.ts'), 'utf8')
check(
  MODULE_SOURCE.includes('export const CITY_SCENARIO_TIER_REGISTRY: readonly CityScenarioTierEntry[] = []'),
  'the registry declaration is literally `= []` in source (no taxonomy content in code)',
)
check(
  MODULE_SOURCE.includes('export const CITY_SCENARIO_TIER_TRIGGER_FIRED = false'),
  'the trigger declaration is literally `= false` in source',
)

expectRefusal(admitTierEntry(probeEntryInput()), 'trigger_not_fired', '不凭 fixture 造画像', 'with the default trigger, admission is refused before any validation')
expectRefusal(
  admitTierEntry({ tier_id: '', city_key: '', scenario_key: '', modifier_ppm: -1, taxonomy_version: '' }),
  'trigger_not_fired', '#339 trigger has not fired',
  'even a wholly invalid entry is refused by the trigger gate first (pre-trigger refusal precedes validation)',
)
const defaultResolution = resolveTier({ cityKey: 'any-city', scenarioKey: 'any-scenario' })
check(defaultResolution.ok && defaultResolution.value.status === 'neutral' && defaultResolution.value.modifier_ppm === TIER_MODIFIER_PPM_NEUTRAL, 'with the default trigger every pair resolves to the neutral modifier ×1.0')
check(defaultResolution.ok && defaultResolution.value.status === 'neutral' && defaultResolution.value.reason === 'trigger_not_fired', 'the neutral reason is trigger_not_fired, stated rather than implied')
check(TIER_MODIFIER_PPM_NEUTRAL === 1_000_000, 'the neutral modifier is exactly ×1.0')
check(TIER_NEUTRAL_REASONS.length === 5 && TIER_NEUTRAL_REASONS.includes('conflicting_evidence'), 'the neutral-reason set is closed and names conflicting evidence')

// ---------------------------------------------------------------------------
// B. Admission shape (mandatory provenance + retirement)
// ---------------------------------------------------------------------------
console.log('B. admission shape: provenance and retirement are mandatory per tier')
const admitted = admitTierEntry(probeEntryInput(), { triggerFired: true, registry: [] })
check(admitted.ok && admitted.value.schema === CITY_SCENARIO_TIER_SCHEMA && admitted.value.taxonomy_version === 'probe.v0', 'a complete probe entry is admitted and carries its schema + taxonomy version')
check(admitted.ok && admitted.value.applies_to === 'ranking' && TIER_APPLICATION_SURFACES.length === 1, 'the only application surface is `ranking` (there is no hard-filter surface)')
check(admitted.ok && admitted.value.provenance.sample_refs.length === 3 && admitted.value.retirement.review_by === REVIEW_BY, 'provenance sample refs and the retirement deadline are preserved')

expectRefusal(admitTierEntry(probeEntryInput({ provenance: undefined }), { triggerFired: true }), 'provenance_required', 'a tier without a stated evidence source is not evidence', 'missing provenance refused')
expectRefusal(admitTierEntry(probeEntryInput({ retirement: undefined }), { triggerFired: true }), 'retirement_required', 'a tier that cannot expire is not evidence', 'missing retirement refused')
expectRefusal(
  admitTierEntry(probeEntryInput({ provenance: { ...(probeEntryInput().provenance as object), sample_source: 'fixture' } }), { triggerFired: true }),
  'closed_set', '不凭 fixture 造画像',
  'a fixture-sourced sample is refused by name (#339 red line)',
)
check(TIER_SAMPLE_SOURCES.length === 1 && TIER_SAMPLE_SOURCES[0] === 'real_usage_sample', 'the admitted sample-source set has exactly one member: real_usage_sample')
expectRefusal(
  admitTierEntry(probeEntryInput({ provenance: { ...(probeEntryInput().provenance as object), evidence_grade: 'vibes' } }), { triggerFired: true }),
  'closed_set', TIER_EVIDENCE_GRADES[0],
  'an evidence grade outside the RFC S2 ordering is refused',
)
expectRefusal(
  admitTierEntry(probeEntryInput({ provenance: { ...(probeEntryInput().provenance as object), sample_refs: ['only-one'] } }), { triggerFired: true }),
  'provenance_required', 'a single anecdote is not a tier',
  `fewer than ${TIER_MIN_SAMPLE_REFS} sample refs refused`,
)
expectRefusal(
  admitTierEntry(probeEntryInput({ provenance: { ...(probeEntryInput().provenance as object), reviewer: '' } }), { triggerFired: true }),
  'provenance_required', 'reviewer',
  'a tier with no accountable reviewer refused',
)
expectRefusal(
  admitTierEntry(probeEntryInput({ provenance: { ...(probeEntryInput().provenance as object), frozen_at: '2026-10-04' } }), { triggerFired: true }),
  'bad_ts', 'date-only',
  'a date-only freeze instant refused',
)
expectRefusal(
  admitTierEntry(probeEntryInput({ retirement: { condition: '', review_by: REVIEW_BY } }), { triggerFired: true }),
  'retirement_required', 'retirement.condition',
  'an empty retirement condition refused',
)
expectRefusal(
  admitTierEntry(probeEntryInput({ retirement: { condition: 'c', review_by: FROZEN_AT } }), { triggerFired: true }),
  'retirement_required', 'must postdate',
  'a review deadline that does not postdate the freeze refused',
)
expectRefusal(admitTierEntry(probeEntryInput({ applies_to: 'hard_filter' }), { triggerFired: true }), 'closed_set', 'memory never enters a hard filter', 'applies_to = hard_filter refused by name')
expectRefusal(admitTierEntry(probeEntryInput({ taxonomy_version: '' }), { triggerFired: true }), 'binding_incomplete', 'taxonomy_version', 'an unversioned tier refused')
expectRefusal(admitTierEntry(probeEntryInput({ tier_id: '  ' }), { triggerFired: true }), 'binding_incomplete', 'tier_id', 'a blank tier id refused')
expectRefusal(admitTierEntry(probeEntryInput({ city_key: '' }), { triggerFired: true }), 'bad_key', 'must not be blank', 'a blank city key refused (blank ≠ unknown)')
expectRefusal(admitTierEntry(probeEntryInput({ scenario_key: 'x'.repeat(TIER_KEY_MAX_CHARS + 1) }), { triggerFired: true }), 'bad_key', 'never prose', 'an over-long scenario key refused')
const oneEntry = [admittedProbe()]
expectRefusal(admitTierEntry(probeEntryInput({ tier_id: 'probe-tier-2' }), { triggerFired: true, registry: oneEntry }), 'duplicate_tier', 'conflicting evidence, not an additional tier', 'a second tier for the same (city, scenario) pair is refused at admission')
expectRefusal(admitTierEntry(probeEntryInput({ city_key: 'city-b' }), { triggerFired: true, registry: oneEntry }), 'duplicate_tier', 'already exists', 'a duplicate tier_id refused')

// ---------------------------------------------------------------------------
// C. Bounded modifier
// ---------------------------------------------------------------------------
console.log('C. bounded modifier: declared [min,max], lower bound > 0 by design')
check(TIER_MODIFIER_PPM_MIN > 0 && TIER_MODIFIER_PPM_MIN < TIER_MODIFIER_PPM_NEUTRAL && TIER_MODIFIER_PPM_MAX > TIER_MODIFIER_PPM_NEUTRAL, 'bounds straddle neutral and the lower bound is strictly positive')
check(admitTierEntry(probeEntryInput({ modifier_ppm: TIER_MODIFIER_PPM_MIN }), { triggerFired: true }).ok, 'the lower bound itself is admissible (inclusive)')
check(admitTierEntry(probeEntryInput({ modifier_ppm: TIER_MODIFIER_PPM_MAX }), { triggerFired: true }).ok, 'the upper bound itself is admissible (inclusive)')
expectRefusal(admitTierEntry(probeEntryInput({ modifier_ppm: 0 }), { triggerFired: true }), 'modifier_bounds', 'never annihilate a candidate', 'a zero modifier is refused (it would annihilate a candidate score)')
expectRefusal(admitTierEntry(probeEntryInput({ modifier_ppm: -1_000_000 }), { triggerFired: true }), 'modifier_bounds', 'outside the declared bounds', 'a negative modifier refused')
expectRefusal(admitTierEntry(probeEntryInput({ modifier_ppm: TIER_MODIFIER_PPM_MIN - 1 }), { triggerFired: true }), 'modifier_bounds', 'outside the declared bounds', 'one ppm below the lower bound refused')
expectRefusal(admitTierEntry(probeEntryInput({ modifier_ppm: TIER_MODIFIER_PPM_MAX + 1 }), { triggerFired: true }), 'modifier_bounds', 'outside the declared bounds', 'one ppm above the upper bound refused')
expectRefusal(admitTierEntry(probeEntryInput({ modifier_ppm: 1_100_000.5 }), { triggerFired: true }), 'modifier_bounds', 'ppm integers are exact', 'a fractional ppm refused')
expectRefusal(admitTierEntry(probeEntryInput({ modifier_ppm: '1100000' }), { triggerFired: true }), 'modifier_bounds', 'must be an integer ppm', 'a string modifier refused')
expectRefusal(admitTierEntry(probeEntryInput({ modifier_ppm: Number.NaN }), { triggerFired: true }), 'modifier_bounds', 'must be an integer ppm', 'NaN modifier refused')

// ---------------------------------------------------------------------------
// D. Neutral fallback, never a guess
// ---------------------------------------------------------------------------
console.log('D. neutral fallback: unknown city / unknown scenario / conflicting evidence')
const probeRegistry: readonly CityScenarioTierEntry[] = [admittedProbe()]
const hit = resolveTier({ cityKey: 'city-a', scenarioKey: 'scenario-x' }, { registry: probeRegistry, triggerFired: true })
check(hit.ok && hit.value.status === 'hit' && hit.value.modifier_ppm === 1_100_000, 'a known (city, scenario) pair resolves to its bounded modifier')
check(hit.ok && hit.value.status === 'hit' && hit.value.explanation.includes('retire when:'), 'a hit explains itself and surfaces its retirement condition')
check(hit.ok && hit.value.status === 'hit' && hit.value.evidence_grade === 'controlled_replay' && hit.value.taxonomy_version === 'probe.v0', 'a hit carries the evidence grade and taxonomy version')

const unknownCity = resolveTier({ cityKey: 'city-zz', scenarioKey: 'scenario-x' }, { registry: probeRegistry, triggerFired: true })
check(unknownCity.ok && unknownCity.value.status === 'neutral' && unknownCity.value.reason === 'unknown_city' && unknownCity.value.modifier_ppm === TIER_MODIFIER_PPM_NEUTRAL, 'unknown city → neutral ×1.0 with reason unknown_city')
check(unknownCity.ok && unknownCity.value.status === 'neutral' && unknownCity.value.explanation.includes('never guessed from a neighbour'), 'the unknown-city fallback states that no neighbour is substituted')
const unknownScenario = resolveTier({ cityKey: 'city-a', scenarioKey: 'scenario-zz' }, { registry: probeRegistry, triggerFired: true })
check(unknownScenario.ok && unknownScenario.value.status === 'neutral' && unknownScenario.value.reason === 'unknown_scenario', 'unknown scenario → neutral ×1.0 with reason unknown_scenario')
const emptyRegistry = resolveTier({ cityKey: 'city-a', scenarioKey: 'scenario-x' }, { registry: [], triggerFired: true })
check(emptyRegistry.ok && emptyRegistry.value.status === 'neutral' && emptyRegistry.value.reason === 'empty_registry', 'empty registry → neutral ×1.0, not a zero weight')

/** Conflicting registry built by bypassing the admission duplicate guard (a defective registry). */
const conflicting: readonly CityScenarioTierEntry[] = [
  admittedProbe({ tier_id: 'probe-conflict-a', modifier_ppm: 1_100_000 }),
  admittedProbe({ tier_id: 'probe-conflict-b', modifier_ppm: 900_000 }),
]
const conflict = resolveTier({ cityKey: 'city-a', scenarioKey: 'scenario-x' }, { registry: conflicting, triggerFired: true })
check(conflict.ok && conflict.value.status === 'neutral' && conflict.value.reason === 'conflicting_evidence' && conflict.value.modifier_ppm === TIER_MODIFIER_PPM_NEUTRAL, 'conflicting evidence → neutral ×1.0, no winner elected')
check(conflict.ok && conflict.value.status === 'neutral' && conflict.value.conflicting_tier_ids.join(',') === 'probe-conflict-a,probe-conflict-b', 'the conflict surfaces both tier ids for diagnosis (without choosing)')
check(conflict.ok && conflict.value.tier_id === null, 'a neutral resolution never reports a tier id')

check(normalizeTierKey(' City-A ', 'k').ok, 'keys normalize: trim + lowercase')
const n1 = normalizeTierKey('  City   A ', 'k')
const n2 = normalizeTierKey('city a', 'k')
check(n1.ok && n2.ok && n1.value === n2.value, 'whitespace collapse + case folding are deterministic and agree')
const caseHit = resolveTier({ cityKey: 'CITY-A', scenarioKey: ' Scenario-X ' }, { registry: probeRegistry, triggerFired: true })
check(caseHit.ok && caseHit.value.status === 'hit', 'a case/whitespace variant of a known key still hits (normalization, not fuzzy matching)')
expectRefusal(resolveTier({ cityKey: '   ', scenarioKey: 'scenario-x' }, { registry: probeRegistry, triggerFired: true }), 'bad_key', 'must not be blank', 'a blank city key is a caller error, not a silent neutral')
expectRefusal(resolveTier({ cityKey: 42, scenarioKey: 'scenario-x' }, { registry: probeRegistry, triggerFired: true }), 'bad_key', 'must be a string', 'a non-string key is a caller error')

// ---------------------------------------------------------------------------
// E. Ranking-only falsification
// ---------------------------------------------------------------------------
console.log('E. FALSIFICATION: a modifier may reorder, it can NEVER remove a candidate')
const candidates: readonly TierRankCandidate[] = [
  { id: 'cand-boosted', cityKey: 'city-a', semantic: 0.50 },
  { id: 'cand-plain-1', cityKey: 'city-b', semantic: 0.54 },
  { id: 'cand-plain-2', cityKey: 'city-c', semantic: 0.10 },
  { id: 'cand-zero', cityKey: 'city-a', semantic: 0 },
]
const neutralRank = applyTierRanking(candidates, { scenarioKey: 'scenario-x' })
check(neutralRank.ok && neutralRank.value.length === candidates.length, 'default (trigger off): all candidates survive')
check(neutralRank.ok && neutralRank.value.map(r => r.id).join(',') === 'cand-plain-1,cand-boosted,cand-plain-2,cand-zero', 'default ordering is pure semantic order (every modifier neutral)')
check(neutralRank.ok && neutralRank.value.every(r => r.modifier_ppm === TIER_MODIFIER_PPM_NEUTRAL && r.tier_id === null), 'default: every row carries the neutral modifier and no tier id')
check(neutralRank.ok && tierRankingFilterViolation(candidates, neutralRank.value) === null, 'the mechanical no-hard-filter check passes for the default ranking')

const boostedRank = applyTierRanking(candidates, { scenarioKey: 'scenario-x' }, { registry: probeRegistry, triggerFired: true })
check(boostedRank.ok && boostedRank.value.map(r => r.id).join(',') === 'cand-boosted,cand-plain-1,cand-plain-2,cand-zero', 'a ×1.1 tier REORDERS: 0.50×1.1 = 0.55 overtakes the plain 0.54')
check(boostedRank.ok && boostedRank.value.length === candidates.length, 'reordering preserves the candidate count exactly')
check(boostedRank.ok && tierRankingFilterViolation(candidates, boostedRank.value) === null, 'the mechanical no-hard-filter check passes for the reordered ranking')
check(boostedRank.ok && boostedRank.value.every(r => candidates.some(c => c.id === r.id && c.semantic === r.semantic)), 'every row preserves its original semantic score (the unmodified ranking is always recoverable)')
check(boostedRank.ok && boostedRank.value.find(r => r.id === 'cand-boosted')!.explanation.includes('probe-tier-1'), 'the applied bias is disclosed per candidate (sponsor-plugin precedent)')

/** The most hostile admissible tier: the lower bound applied to a zero semantic score. */
const minTier: readonly CityScenarioTierEntry[] = [admittedProbe({ tier_id: 'probe-min', modifier_ppm: TIER_MODIFIER_PPM_MIN })]
const minRank = applyTierRanking(candidates, { scenarioKey: 'scenario-x' }, { registry: minTier, triggerFired: true })
check(minRank.ok && minRank.value.length === candidates.length, 'FALSIFICATION: even the lower-bound modifier removes nobody (count unchanged)')
check(minRank.ok && minRank.value.some(r => r.id === 'cand-zero' && r.score === 0), 'FALSIFICATION: a zero-semantic candidate scores 0 and is still PRESENT (score 0 ≠ removal)')
check(minRank.ok && tierRankingFilterViolation(candidates, minRank.value) === null, 'FALSIFICATION: the no-hard-filter check passes at the hostile bound')
check(
  minRank.ok && !Object.keys(minRank.value[0]).some(k => /exclud|filter|drop|reject|threshold/i.test(k)),
  'the ranked row shape exposes no exclude/filter/drop/threshold field (no filter surface exists)',
)
let everPresent = true
for (let semantic = 0; semantic <= 10; semantic++) {
  for (const registry of [[] as readonly CityScenarioTierEntry[], probeRegistry, minTier]) {
    const probe = applyTierRanking([{ id: 'solo', cityKey: 'city-a', semantic: semantic / 10 }], { scenarioKey: 'scenario-x' }, { registry, triggerFired: true })
    if (!probe.ok || probe.value.length !== 1 || probe.value[0].id !== 'solo') everPresent = false
  }
}
check(everPresent, 'FALSIFICATION battery: across 11 semantic scores × 3 registries the candidate is never dropped')
expectRefusal(applyTierRanking([{ id: '', cityKey: 'city-a', semantic: 1 }], { scenarioKey: 'scenario-x' }), 'bad_candidate', 'non-empty id', 'a blank candidate id refused')
expectRefusal(applyTierRanking([{ id: 'a', cityKey: 'city-a', semantic: Number.NaN }], { scenarioKey: 'scenario-x' }), 'bad_candidate', 'must be finite', 'a non-finite semantic score refused')
expectRefusal(
  applyTierRanking([{ id: 'a', cityKey: 'city-a', semantic: 1 }, { id: 'a', cityKey: 'city-b', semantic: 2 }], { scenarioKey: 'scenario-x' }),
  'bad_candidate', 'duplicate candidate id',
  'duplicate candidate ids refused (ranking inputs are a set)',
)
check(tierRankingFilterViolation(candidates, []) !== null, 'the mechanical check CATCHES a dropped-candidate violation (the check itself is falsifiable)')
check(tierRankingFilterViolation(candidates, (neutralRank.ok ? neutralRank.value : []).slice(0, 3)) !== null, 'the mechanical check catches a partial drop')

// ---------------------------------------------------------------------------
// F. Determinism + versioning
// ---------------------------------------------------------------------------
console.log('F. determinism, stable ties, defective registry refused')
const runA = applyTierRanking(candidates, { scenarioKey: 'scenario-x' }, { registry: probeRegistry, triggerFired: true })
const runB = applyTierRanking(candidates, { scenarioKey: 'scenario-x' }, { registry: probeRegistry, triggerFired: true })
check(runA.ok && runB.ok && JSON.stringify(runA.value) === JSON.stringify(runB.value), 'identical inputs produce byte-identical output (deterministic)')
const ties: readonly TierRankCandidate[] = [
  { id: 'tie-1', cityKey: 'city-b', semantic: 0.4 },
  { id: 'tie-2', cityKey: 'city-c', semantic: 0.4 },
  { id: 'tie-3', cityKey: 'city-d', semantic: 0.4 },
]
const tieRank = applyTierRanking(ties, { scenarioKey: 'scenario-x' }, { registry: probeRegistry, triggerFired: true })
check(tieRank.ok && tieRank.value.map(r => r.id).join(',') === 'tie-1,tie-2,tie-3', 'ties keep declaration order (stable sort)')
const defective: readonly CityScenarioTierEntry[] = [{ ...admittedProbe(), modifier_ppm: 5_000_000 }]
expectRefusal(resolveTier({ cityKey: 'city-a', scenarioKey: 'scenario-x' }, { registry: defective, triggerFired: true }), 'modifier_bounds', 'never clamped silently', 'a defective registry entry is refused at read time, never clamped silently')
expectRefusal(applyTierRanking(candidates, { scenarioKey: 'scenario-x' }, { registry: defective, triggerFired: true }), 'modifier_bounds', 'defective registry entry', 'ranking propagates the defective-registry refusal instead of degrading')

console.log(`\nCITY-SCENARIO TIER MECHANISM TESTS (#339, simulated_trigger_drill / fixture_contract; registry stays EMPTY): ${passed} pass${process.exitCode ? ', FAIL' : ' (all green)'}`)
