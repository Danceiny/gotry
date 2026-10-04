/**
 * City × scenario tiering MECHANISM v1 (issue #339 contract slice,
 * SIMULATED-TRIGGER DRILL — default OFF, zero callers, trigger flag frozen false,
 * registry frozen EMPTY).
 *
 * ⚠ Evidence boundary: this module ships the MECHANISM only. #339's trigger is
 * "reviewable real usage samples with a stated scenario vocabulary and success
 * metric"; it has NOT fired. The tracker is explicit that a profile must never be
 * fabricated from fixtures (「没有样本时保持研究/设计状态,不凭 fixture 造画像」),
 * so there is deliberately NO taxonomy CONTENT here:
 *   - `CITY_SCENARIO_TIER_REGISTRY` is frozen `[]`;
 *   - `CITY_SCENARIO_TIER_TRIGGER_FIRED` is frozen `false`, and `admitTierEntry`
 *     refuses every admission before validating anything while it is false, so no
 *     tier can enter the registry without real samples and a founder decision;
 *   - every resolution therefore returns the NEUTRAL modifier today.
 * Any scenario vocabulary proposal lives in the drill report as a clearly labelled
 * unvalidated hypothesis, never in this file.
 *
 * Shape (mirrors ts/capabilities/fx-contract.ts #344 / ts/capabilities/geo-atlas.ts
 * #342 / ts/src/session-zones.ts P4-1): pure functions, zero IO / network / timers,
 * closed error-code set, typed results, deterministic, versioned, fail-closed.
 *
 * Frozen upstream constraints (READ-ONLY reuse):
 *  - docs/design/memory-design.md §1 item 3: the profile only feeds ranking, never
 *    hard filters — future shape `semantic × bounded_modifier`, "otherwise memory
 *    would filter the search down to nothing";
 *  - docs/rfc/loopx-inspired-upgrades-rfc.md S2: the ranking form
 *    `rank = semantic × bounded_modifier` and the evidence-grade ordering
 *    `owner_correction > controlled_replay > deterministic_effect > evaluator_inference`;
 *  - ts/capabilities/sponsor-plugin.ts `rankSponsorCandidates` precedent: a
 *    non-semantic weight never silently rewrites the sort key, and a tie-break
 *    bias is disclosed per candidate;
 *  - ts/src/memory-decay.ts: decay touches behavioural events only and exposes no
 *    motivation-profile API; this module likewise touches no profile and no store.
 *
 * Red lines encoded structurally (each has a falsification test in
 * ts/scripts/city-scenario-tier-tests.ts, run-all §86):
 *  1. ranking only — `applyTierRanking` has NO filter/exclude surface at all, and
 *     the output always contains exactly the input candidates: a modifier may
 *     reorder, it can never remove a candidate (not even at the lower bound with
 *     a zero semantic score);
 *  2. bounded — the modifier is an integer ppm inside declared [min,max] bounds;
 *     0, negative, non-integer and out-of-range are refused at admission, so no
 *     tier can zero a candidate out;
 *  3. neutral fallback, never a guess — unknown city, unknown scenario, conflicting
 *     evidence, empty registry and trigger-not-fired all return the NEUTRAL
 *     modifier with a stated reason; conflicting entries never elect a winner;
 *  4. per-tier provenance (evidence grade + real sample refs + reviewer + freeze
 *     instant) and a retirement condition + review deadline are MANDATORY;
 *  5. deterministic and versioned: same inputs → byte-identical result; ties keep
 *     declaration order.
 *
 * Only the real #339 trigger can supply: the taxonomy members themselves, the
 * scenario vocabulary, the success metric, the numeric bounds justified by data,
 * and the before/after ranking hypotheses with real counterexamples.
 *
 * @module src/city-scenario-tier
 */

/** Versioned contract schema id (readers validate it). */
export const CITY_SCENARIO_TIER_SCHEMA = 'gotry_city_scenario_tier.v1'

/**
 * #339 implementation trigger gate, frozen false. Flipping it true requires
 * reviewable real usage samples plus an explicit scenario vocabulary and success
 * metric. While false, `admitTierEntry` refuses every admission.
 */
export const CITY_SCENARIO_TIER_TRIGGER_FIRED = false

/**
 * Declared modifier bounds, in ppm (1_000_000 = neutral ×1.0).
 *
 * NOT data-derived: RFC S2 fixes the FORM (`semantic × bounded_modifier`) but the
 * repo states no numeric interval anywhere. These values are drill-declared so the
 * bound CHECK can be proven; the interval itself must be re-frozen from real
 * samples when #339's trigger fires. The lower bound is deliberately > 0 so no
 * tier can ever annihilate a candidate's semantic score.
 */
export const TIER_MODIFIER_PPM_NEUTRAL = 1_000_000
export const TIER_MODIFIER_PPM_MIN = 850_000
export const TIER_MODIFIER_PPM_MAX = 1_150_000

/** The only admitted application surface. There is no hard-filter surface. */
export const TIER_APPLICATION_SURFACES = ['ranking'] as const
export type TierApplicationSurface = (typeof TIER_APPLICATION_SURFACES)[number]

/** Evidence grades, strongest first (RFC S2 ordering, read-only reuse). */
export const TIER_EVIDENCE_GRADES = ['owner_correction', 'controlled_replay', 'deterministic_effect', 'evaluator_inference'] as const
export type TierEvidenceGrade = (typeof TIER_EVIDENCE_GRADES)[number]

/**
 * Admitted sample sources. Exactly one member: a reviewable real usage sample.
 * A fixture / synthetic / model-authored sample is outside the closed set and is
 * refused by name — this is #339's「不凭 fixture 造画像」as code.
 */
export const TIER_SAMPLE_SOURCES = ['real_usage_sample'] as const
export type TierSampleSource = (typeof TIER_SAMPLE_SOURCES)[number]

/** Bounded shapes: keys are vocabulary members, never free prose. */
export const TIER_KEY_MAX_CHARS = 48
export const TIER_TEXT_MAX_CHARS = 200
export const TIER_MAX_REGISTRY_ENTRIES = 512

// ---------------------------------------------------------------------------
// Typed results (closed error-code set)
// ---------------------------------------------------------------------------

export type TierErrorCode =
  /** the #339 trigger has not fired: no tier may be admitted from fixtures */
  | 'trigger_not_fired'
  /** a value outside a closed set (evidence grade, sample source, surface) */
  | 'closed_set'
  /** a mandatory field is missing or blank */
  | 'binding_incomplete'
  /** a city/scenario key is empty, over-long or not normalizable */
  | 'bad_key'
  /** the modifier is non-integer, zero, negative or outside declared bounds */
  | 'modifier_bounds'
  /** provenance (evidence grade / real sample refs / reviewer / freeze instant) incomplete */
  | 'provenance_required'
  /** retirement condition or review deadline missing / incoherent */
  | 'retirement_required'
  /** a timestamp is missing, unparseable or date-only */
  | 'bad_ts'
  /** the same tier_id, or the same (city, scenario) pair, already exists */
  | 'duplicate_tier'
  /** a candidate shape is invalid (non-finite semantic score, blank id, duplicate id) */
  | 'bad_candidate'
  /** a declared bound (registry size, text length) is exceeded */
  | 'bound_exceeded'

export type TierResult<T> = { ok: true; value: T } | { ok: false; code: TierErrorCode; detail: string }

function fail<T>(code: TierErrorCode, detail: string): TierResult<T> {
  return { ok: false, code, detail }
}
function pass<T>(value: T): TierResult<T> {
  return { ok: true, value }
}

// ---------------------------------------------------------------------------
// Key normalization (deterministic; never a guess)
// ---------------------------------------------------------------------------

/**
 * Normalize a city / scenario key: trim, collapse internal whitespace, lowercase.
 * No transliteration, no alias expansion, no fuzzy matching — an unrecognized key
 * stays unrecognized and falls back to neutral (ADR-10: nothing is fabricated).
 */
export function normalizeTierKey(value: unknown, label: string): TierResult<string> {
  if (typeof value !== 'string') {
    return fail('bad_key', `${label} must be a string, got ${JSON.stringify(value)}`)
  }
  const normalized = value.trim().replace(/\s+/g, ' ').toLowerCase()
  if (normalized === '') return fail('bad_key', `${label} must not be blank (a blank key is not an unknown key; callers must pass the key they actually have)`)
  if (normalized.length > TIER_KEY_MAX_CHARS) {
    return fail('bad_key', `${label} exceeds ${TIER_KEY_MAX_CHARS} chars (${normalized.length}) — a key is a vocabulary member, never prose`)
  }
  return pass(normalized)
}

function requiredText(label: string, value: unknown, code: TierErrorCode): TierResult<string> {
  if (typeof value !== 'string' || value.trim() === '') {
    return fail(code, `${label} must be a non-empty string, got ${JSON.stringify(value)}`)
  }
  if (value.length > TIER_TEXT_MAX_CHARS) {
    return fail('bound_exceeded', `${label} exceeds ${TIER_TEXT_MAX_CHARS} chars (${value.length})`)
  }
  return pass(value.trim())
}

function requiredInstant(label: string, value: unknown): TierResult<string> {
  if (typeof value !== 'string' || value.trim() === '') {
    return fail('bad_ts', `${label} must be a non-empty ISO-8601 instant, got ${JSON.stringify(value)}`)
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(value.trim())) {
    return fail('bad_ts', `${label} must carry a full time-of-day (date-only '${value}' cannot order a freeze/review)`)
  }
  const ms = Date.parse(value)
  if (!Number.isFinite(ms)) return fail('bad_ts', `${label} is not a parseable ISO-8601 instant: ${JSON.stringify(value)}`)
  return pass(new Date(ms).toISOString())
}

// ---------------------------------------------------------------------------
// Taxonomy schema (shape only — the registry stays empty)
// ---------------------------------------------------------------------------

/** Mandatory provenance of one tier: where the weight came from. */
export interface TierProvenance {
  readonly evidence_grade: TierEvidenceGrade
  readonly sample_source: TierSampleSource
  /** opaque references to the reviewable real samples (never sample CONTENT) */
  readonly sample_refs: readonly string[]
  /** who froze this tier (accountable reviewer) */
  readonly reviewer: string
  readonly frozen_at: string
}

/** Mandatory retirement condition: a tier that cannot expire is not evidence. */
export interface TierRetirement {
  /** the stated condition under which this tier is withdrawn */
  readonly condition: string
  /** the deadline by which the tier must be re-reviewed or retired */
  readonly review_by: string
}

export interface CityScenarioTierEntry {
  readonly schema: typeof CITY_SCENARIO_TIER_SCHEMA
  readonly tier_id: string
  readonly city_key: string
  readonly scenario_key: string
  /** bounded integer ppm; the ONLY numeric effect a tier may have */
  readonly modifier_ppm: number
  /** the only admitted application surface */
  readonly applies_to: TierApplicationSurface
  readonly provenance: TierProvenance
  readonly retirement: TierRetirement
  /** taxonomy version this entry belongs to */
  readonly taxonomy_version: string
}

/**
 * Runtime taxonomy registry, frozen EMPTY — #339 forbids fabricating city-scenario
 * tiers from fixtures. A non-empty value requires reviewable real samples and is a
 * founder decision; the focused suite asserts this declaration stays `[]` in source.
 */
export const CITY_SCENARIO_TIER_REGISTRY: readonly CityScenarioTierEntry[] = []

/** Minimum reviewable real samples behind one tier (a single anecdote is not a tier). */
export const TIER_MIN_SAMPLE_REFS = 3

/**
 * Admit one taxonomy entry.
 *
 * While `CITY_SCENARIO_TIER_TRIGGER_FIRED` is false this refuses BEFORE validating
 * anything, so no tier can be fabricated from fixtures. Tests and a future admitted
 * slice pass `{ triggerFired: true }` explicitly to exercise the validation shape.
 */
export function admitTierEntry(
  input: {
    tier_id: unknown
    city_key: unknown
    scenario_key: unknown
    modifier_ppm: unknown
    applies_to?: unknown
    provenance?: unknown
    retirement?: unknown
    taxonomy_version: unknown
  },
  options?: { triggerFired?: boolean; registry?: readonly CityScenarioTierEntry[] },
): TierResult<CityScenarioTierEntry> {
  const triggerFired = options?.triggerFired ?? CITY_SCENARIO_TIER_TRIGGER_FIRED
  if (!triggerFired) {
    return fail(
      'trigger_not_fired',
      '#339 trigger has not fired (reviewable real usage samples + an explicit scenario vocabulary and success metric are required); zero tiers admitted — 不凭 fixture 造画像',
    )
  }
  const registry = options?.registry ?? CITY_SCENARIO_TIER_REGISTRY
  if (registry.length >= TIER_MAX_REGISTRY_ENTRIES) {
    return fail('bound_exceeded', `registry already holds ${registry.length} entries (bound ${TIER_MAX_REGISTRY_ENTRIES}); an unbounded taxonomy is not explainable`)
  }

  const tierId = requiredText('tier_id', input?.tier_id, 'binding_incomplete')
  if (!tierId.ok) return tierId
  const cityKey = normalizeTierKey(input?.city_key, 'city_key')
  if (!cityKey.ok) return cityKey
  const scenarioKey = normalizeTierKey(input?.scenario_key, 'scenario_key')
  if (!scenarioKey.ok) return scenarioKey
  const version = requiredText('taxonomy_version', input?.taxonomy_version, 'binding_incomplete')
  if (!version.ok) return version

  const modifier = input?.modifier_ppm
  if (typeof modifier !== 'number' || !Number.isInteger(modifier)) {
    return fail('modifier_bounds', `modifier_ppm must be an integer ppm, got ${JSON.stringify(modifier)} (floats drift; ppm integers are exact)`)
  }
  if (modifier < TIER_MODIFIER_PPM_MIN || modifier > TIER_MODIFIER_PPM_MAX) {
    return fail(
      'modifier_bounds',
      `modifier_ppm ${modifier} is outside the declared bounds [${TIER_MODIFIER_PPM_MIN},${TIER_MODIFIER_PPM_MAX}] (lower bound is > 0 by design: a tier may reorder, never annihilate a candidate)`,
    )
  }

  const surface = input?.applies_to ?? 'ranking'
  if (!(TIER_APPLICATION_SURFACES as readonly string[]).includes(surface as string)) {
    return fail('closed_set', `applies_to must be one of [${TIER_APPLICATION_SURFACES.join('/')}], got ${JSON.stringify(surface)} — memory never enters a hard filter (memory-design §1.3)`)
  }

  const prov = input?.provenance as Record<string, unknown> | undefined
  if (prov === null || typeof prov !== 'object') {
    return fail('provenance_required', 'provenance is mandatory: a tier without a stated evidence source is not evidence')
  }
  if (!(TIER_EVIDENCE_GRADES as readonly string[]).includes(prov['evidence_grade'] as string)) {
    return fail('closed_set', `provenance.evidence_grade must be one of [${TIER_EVIDENCE_GRADES.join('/')}], got ${JSON.stringify(prov['evidence_grade'])}`)
  }
  if (!(TIER_SAMPLE_SOURCES as readonly string[]).includes(prov['sample_source'] as string)) {
    return fail(
      'closed_set',
      `provenance.sample_source must be one of [${TIER_SAMPLE_SOURCES.join('/')}], got ${JSON.stringify(prov['sample_source'])} — fixture/synthetic/model-authored samples are refused (#339: 不凭 fixture 造画像)`,
    )
  }
  const refs = prov['sample_refs']
  if (!Array.isArray(refs) || refs.length < TIER_MIN_SAMPLE_REFS || !refs.every(r => typeof r === 'string' && r.trim() !== '')) {
    return fail(
      'provenance_required',
      `provenance.sample_refs must list at least ${TIER_MIN_SAMPLE_REFS} non-empty reviewable sample references, got ${JSON.stringify(refs)} (a single anecdote is not a tier)`,
    )
  }
  const reviewer = requiredText('provenance.reviewer', prov['reviewer'], 'provenance_required')
  if (!reviewer.ok) return reviewer
  const frozenAt = requiredInstant('provenance.frozen_at', prov['frozen_at'])
  if (!frozenAt.ok) return frozenAt

  const ret = input?.retirement as Record<string, unknown> | undefined
  if (ret === null || typeof ret !== 'object') {
    return fail('retirement_required', 'retirement is mandatory: a tier that cannot expire is not evidence (#339 acceptance 1 requires a retirement condition per class)')
  }
  const condition = requiredText('retirement.condition', ret['condition'], 'retirement_required')
  if (!condition.ok) return condition
  const reviewBy = requiredInstant('retirement.review_by', ret['review_by'])
  if (!reviewBy.ok) return reviewBy
  if (reviewBy.value <= frozenAt.value) {
    return fail('retirement_required', `retirement.review_by ${reviewBy.value} must postdate provenance.frozen_at ${frozenAt.value}`)
  }

  if (registry.some(e => e.tier_id === tierId.value)) {
    return fail('duplicate_tier', `tier_id ${tierId.value} already exists in the registry`)
  }
  if (registry.some(e => e.city_key === cityKey.value && e.scenario_key === scenarioKey.value)) {
    return fail(
      'duplicate_tier',
      `(city ${cityKey.value}, scenario ${scenarioKey.value}) already carries a tier; a second weight for the same pair is conflicting evidence, not an additional tier`,
    )
  }

  return pass(Object.freeze({
    schema: CITY_SCENARIO_TIER_SCHEMA,
    tier_id: tierId.value,
    city_key: cityKey.value,
    scenario_key: scenarioKey.value,
    modifier_ppm: modifier,
    applies_to: surface as TierApplicationSurface,
    provenance: Object.freeze({
      evidence_grade: prov['evidence_grade'] as TierEvidenceGrade,
      sample_source: prov['sample_source'] as TierSampleSource,
      sample_refs: Object.freeze([...(refs as string[])]) as readonly string[],
      reviewer: reviewer.value,
      frozen_at: frozenAt.value,
    }),
    retirement: Object.freeze({ condition: condition.value, review_by: reviewBy.value }),
    taxonomy_version: version.value,
  }))
}

// ---------------------------------------------------------------------------
// Resolution: neutral fallback, never a guess
// ---------------------------------------------------------------------------

export const TIER_NEUTRAL_REASONS = [
  'trigger_not_fired',
  'empty_registry',
  'unknown_city',
  'unknown_scenario',
  'conflicting_evidence',
] as const
export type TierNeutralReason = (typeof TIER_NEUTRAL_REASONS)[number]

export type TierResolution =
  | {
      readonly status: 'hit'
      readonly modifier_ppm: number
      readonly tier_id: string
      readonly taxonomy_version: string
      readonly evidence_grade: TierEvidenceGrade
      readonly explanation: string
    }
  | {
      readonly status: 'neutral'
      readonly modifier_ppm: typeof TIER_MODIFIER_PPM_NEUTRAL
      readonly tier_id: null
      readonly reason: TierNeutralReason
      /** tier ids in conflict, when the reason is conflicting_evidence (diagnosis only) */
      readonly conflicting_tier_ids: readonly string[]
      readonly explanation: string
    }

function neutral(reason: TierNeutralReason, explanation: string, conflicting: readonly string[] = []): TierResolution {
  return Object.freeze({
    status: 'neutral' as const,
    modifier_ppm: TIER_MODIFIER_PPM_NEUTRAL,
    tier_id: null,
    reason,
    conflicting_tier_ids: Object.freeze([...conflicting]) as readonly string[],
    explanation,
  })
}

/**
 * Resolve the bounded modifier for one (city, scenario) pair.
 *
 * Returns NEUTRAL (×1.0) with a stated reason for: trigger not fired, empty
 * registry, unknown city, unknown scenario, and conflicting evidence. Conflicting
 * entries never elect a winner (geo-atlas `ambiguous` discipline). A malformed key
 * is a caller error and is reported as such rather than silently neutralized.
 */
export function resolveTier(
  query: { cityKey: unknown; scenarioKey: unknown },
  options?: { registry?: readonly CityScenarioTierEntry[]; triggerFired?: boolean },
): TierResult<TierResolution> {
  const cityKey = normalizeTierKey(query?.cityKey, 'cityKey')
  if (!cityKey.ok) return cityKey
  const scenarioKey = normalizeTierKey(query?.scenarioKey, 'scenarioKey')
  if (!scenarioKey.ok) return scenarioKey

  const triggerFired = options?.triggerFired ?? CITY_SCENARIO_TIER_TRIGGER_FIRED
  if (!triggerFired) {
    return pass(neutral('trigger_not_fired', '#339 trigger has not fired; every city×scenario pair resolves to the neutral modifier ×1.0 (no tier is guessed)'))
  }
  const registry = options?.registry ?? CITY_SCENARIO_TIER_REGISTRY
  if (registry.length === 0) {
    return pass(neutral('empty_registry', 'the taxonomy registry is empty; neutral ×1.0 (an empty taxonomy is not a zero weight)'))
  }
  const cityMatches = registry.filter(e => e.city_key === cityKey.value)
  if (cityMatches.length === 0) {
    return pass(neutral('unknown_city', `city '${cityKey.value}' carries no tier in taxonomy; neutral ×1.0 (an unknown city is never guessed from a neighbour)`))
  }
  const matches = cityMatches.filter(e => e.scenario_key === scenarioKey.value)
  if (matches.length === 0) {
    return pass(neutral('unknown_scenario', `scenario '${scenarioKey.value}' carries no tier for city '${cityKey.value}'; neutral ×1.0 (an unknown scenario is never approximated by another scenario)`))
  }
  if (matches.length > 1) {
    return pass(neutral(
      'conflicting_evidence',
      `city '${cityKey.value}' × scenario '${scenarioKey.value}' carries ${matches.length} conflicting tiers; neutral ×1.0 and no winner is elected (conflict is surfaced, never resolved by guessing)`,
      matches.map(e => e.tier_id),
    ))
  }
  const entry = matches[0]
  if (entry.modifier_ppm < TIER_MODIFIER_PPM_MIN || entry.modifier_ppm > TIER_MODIFIER_PPM_MAX) {
    return fail('modifier_bounds', `registry entry ${entry.tier_id} carries modifier_ppm ${entry.modifier_ppm} outside the declared bounds [${TIER_MODIFIER_PPM_MIN},${TIER_MODIFIER_PPM_MAX}] — a defective registry entry is refused, never clamped silently`)
  }
  return pass(Object.freeze({
    status: 'hit' as const,
    modifier_ppm: entry.modifier_ppm,
    tier_id: entry.tier_id,
    taxonomy_version: entry.taxonomy_version,
    evidence_grade: entry.provenance.evidence_grade,
    explanation: `tier ${entry.tier_id} (${entry.taxonomy_version}, evidence ${entry.provenance.evidence_grade}) applies ×${(entry.modifier_ppm / 1_000_000).toFixed(6)} to the ranking score of city '${entry.city_key}' under scenario '${entry.scenario_key}'; retire when: ${entry.retirement.condition}`,
  }))
}

// ---------------------------------------------------------------------------
// Ranking-only application (no filter surface exists)
// ---------------------------------------------------------------------------

/**
 * One ranking candidate. `semantic` is the authoritative relevance score and must
 * be non-negative: the contract is MULTIPLICATIVE, so a negative score would
 * invert the meaning of every modifier (a boost above 1.0 would demote the
 * candidate and a penalty below 1.0 would promote it). A negative score is
 * therefore refused rather than silently given inverted semantics.
 */
export interface TierRankCandidate {
  readonly id: string
  readonly cityKey: string
  readonly semantic: number
}

/** A ranked candidate: the semantic score is preserved alongside the applied modifier. */
export interface TierRankedCandidate {
  readonly id: string
  readonly semantic: number
  readonly modifier_ppm: number
  readonly score: number
  readonly tier_id: string | null
  /** per-candidate disclosure of the bias applied (sponsor-plugin precedent) */
  readonly explanation: string
}

/**
 * Apply tier modifiers to a candidate ranking.
 *
 * There is deliberately NO filter, exclude, drop or threshold parameter and no
 * such field in the result: the returned array always contains exactly the input
 * candidates (same ids, same count), only reordered. `semantic` is preserved on
 * every output row so a caller can always recover the unmodified ranking.
 * Ties keep declaration order (stable).
 */
export function applyTierRanking(
  candidates: readonly TierRankCandidate[],
  context: { scenarioKey: unknown },
  options?: { registry?: readonly CityScenarioTierEntry[]; triggerFired?: boolean },
): TierResult<readonly TierRankedCandidate[]> {
  if (!Array.isArray(candidates)) return fail('bad_candidate', 'candidates must be an array')
  const seen = new Set<string>()
  for (const c of candidates) {
    if (c === null || typeof c !== 'object' || typeof c.id !== 'string' || c.id.trim() === '') {
      return fail('bad_candidate', `every candidate needs a non-empty id, got ${JSON.stringify(c)}`)
    }
    if (seen.has(c.id)) return fail('bad_candidate', `duplicate candidate id ${c.id} (ranking inputs must be a set)`)
    seen.add(c.id)
    if (typeof c.semantic !== 'number' || !Number.isFinite(c.semantic)) {
      return fail('bad_candidate', `candidate ${c.id} semantic score must be finite, got ${String(c.semantic)}`)
    }
    if (c.semantic < 0) {
      return fail(
        'bad_candidate',
        `candidate ${c.id} semantic score must be non-negative, got ${String(c.semantic)} — the ranking contract is multiplicative, so a negative score would invert every modifier (a boost would demote)`,
      )
    }
  }

  const ranked: TierRankedCandidate[] = []
  for (const c of candidates) {
    const resolution = resolveTier({ cityKey: c.cityKey, scenarioKey: context?.scenarioKey }, options)
    if (!resolution.ok) return resolution
    const r = resolution.value
    ranked.push(Object.freeze({
      id: c.id,
      semantic: c.semantic,
      modifier_ppm: r.modifier_ppm,
      score: (c.semantic * r.modifier_ppm) / 1_000_000,
      tier_id: r.status === 'hit' ? r.tier_id : null,
      explanation: r.explanation,
    }))
  }

  const ordered = ranked
    .map((row, index) => ({ row, index }))
    .sort((a, b) => (b.row.score - a.row.score) || (a.index - b.index))
    .map(({ row }) => row)

  // Structural invariant: ranking never removes a candidate.
  if (ordered.length !== candidates.length || !candidates.every(c => ordered.some(r => r.id === c.id))) {
    return fail('bad_candidate', 'internal invariant violated: tier ranking must preserve the candidate set exactly (memory never enters a hard filter)')
  }
  return pass(Object.freeze([...ordered]) as readonly TierRankedCandidate[])
}

/**
 * Mechanical no-hard-filter check a caller (or a gate) can run: the ranked output
 * must contain exactly the input candidate ids. Returns a violation string, or null.
 */
export function tierRankingFilterViolation(
  before: readonly TierRankCandidate[],
  after: readonly TierRankedCandidate[],
): string | null {
  if (before.length !== after.length) {
    return `tier ranking changed the candidate count ${before.length} → ${after.length}: memory may reorder, never filter (memory-design §1.3)`
  }
  const missing = before.filter(c => !after.some(r => r.id === c.id)).map(c => c.id)
  if (missing.length > 0) return `tier ranking dropped candidates [${missing.join(',')}]: memory may reorder, never filter`
  const added = after.filter(r => !before.some(c => c.id === r.id)).map(r => r.id)
  if (added.length > 0) return `tier ranking invented candidates [${added.join(',')}]`
  return null
}
