#!/usr/bin/env tsx
/**
 * LLM-persona simulation harness for the M3 capture path (issue #22).
 *
 * EVIDENCE BOUNDARY — read this before reading the code.
 * Everything this harness produces is SYNTHETIC. It drives a persona LLM against the real
 * GoTry session logic and records the funnel with `src/m3-cohort.ts`, so it validates the
 * capture path, the funnel mechanics, interview friction and system-side measurements
 * (fact-gate claim adjudication). It proves NOTHING about real-traveller value and can
 * never contribute to M3 or M4 exit evidence. Two record-level facts enforce that, and
 * neither depends on the other:
 *   - every simulated participant is enrolled `test_or_staff=true`, so the scorer's own
 *     exclusion drops all of them and its eligible sample is 0 — true even if a manifest
 *     were relabelled, because the exclusion lives in the records;
 *   - the manifest carries `evidence_kind=synthetic_fixture`, which `product-metrics.ts`
 *     refuses to turn into `business_pass=true` regardless of the numbers.
 * The export attestation is a third, weaker thing: it is keyed, so it detects tampering by
 * anyone without the capture key — it says nothing about whether the participants were real.
 * Because the scorer excludes every simulated participant, the funnel numbers a reader
 * wants are computed here by `summarizeFunnel()`, not read off the scorer.
 *
 * What is real in a run and what is simulated:
 *   real      — the deterministic interview (`src/loop.ts interviewNext`), the spec gate,
 *               the planning-window gate, the unified solver (`src/unified.ts`), the
 *               rendered plan, and the registered `gotry_fact_gate` tool reading the
 *               session's own bookable-fact registry from an isolated `stateRoot`;
 *   simulated — the traveller. Persona utterances, the finalize decision and the NPS score
 *               come from the persona LLM reading a persona card, not from a person.
 *
 * Harness shape (documented in docs/evaluation/persona-sim-report.md §2): the product side
 * runs in-process through the same seam `scripts/nightly-evidence.ts` already uses —
 * `createOpenAICompatLlm` + `newState`/`runTurn` + `solveUnified` — and the product's own
 * registered tools are mounted with `src/index.ts apply()` against a per-persona
 * `mkdtemp` stateRoot, exactly the way `scripts/smoke.ts` does it.
 *
 * Discipline:
 *   - no credentials and not `--dry-run` => exit 0 with state `waiting_external_evidence`,
 *     zero writes, zero spend (same stop rule as `scripts/nightly-evidence.ts`);
 *   - this script never reads a `.env` file: credentials come from the environment only;
 *   - every model must have a sealed price entry before any spend (fail-closed), and
 *     `responsesMissingUsage > 0` makes cost unprovable, which is also fail-closed;
 *   - `GOTRY_PERSONA_BUDGET_USD` (default 0.25) stops the batch and exits 3;
 *   - PATH/HOME are scrubbed for the duration of the batch so the session's POI probe
 *     (`src/loop.ts` -> `capabilities/anything.ts`) cannot reach the live `hbcli` backend;
 *   - one `mkdtemp` stateRoot per persona, bounded turns, bounded deadlines, concurrency
 *     <= 2, deterministic persona ordering, every temp dir and server closed in `finally`.
 *
 * Offline:  npx tsx scripts/persona-sim.ts --dry-run --format json
 * Real:     see docs/evaluation/persona-sim-report.md §3 for the single command.
 */

import { createHash } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import { apply } from '../src/index.ts'
import { createOpenAICompatLlm, type LlmUsageTracker } from '../src/dsh-llm.ts'
import { newState, renderSolve, runTurn, type LlmPort } from '../src/loop.ts'
import { solveUnified } from '../src/unified.ts'
import { realtimeSolvePort } from '../src/realtime-pricing.ts'
import type { TripState, Turn } from '../src/contracts.ts'
import {
  assertSafeStateRoot,
  enrollParticipant,
  exportM3Cohort,
  initM3Cohort,
  M3CohortError,
  M3_SIMULATION_PROVENANCE_SCHEMA,
  recordNps,
  recordPlanDelivered,
  recordPlanFinalized,
  recordPoiLock,
  verifyExportedEvidence,
  type Clock,
  type M3SimulationProvenance,
} from '../src/m3-cohort.ts'
import { loadPriceTable, priceRunCost, type LlmPriceTable } from './nightly-evidence.ts'
import { parseCohortRecord, parseManifest, scoreProductMetrics, type M3ProductMetricsSummary } from './product-metrics.ts'

const __dirname = dirname(fileURLToPath(import.meta.url))
const TS_ROOT = resolve(__dirname, '..')
const REPO_ROOT = resolve(TS_ROOT, '..')

export const PERSONA_DECK_SCHEMA = 'gotry_persona_sim_deck_v1' as const
export const DEFAULT_DECK_PATH = join(TS_ROOT, 'data', 'persona-sim', 'personas.json')
export const DEFAULT_BUDGET_USD = 0.25
export const DEFAULT_MAX_TURNS = 8
export const MAX_CONCURRENCY = 2
export const PERSONA_SYSTEM_MARKER = 'GOTRY-PERSONA-SIM'
/** Non-secret fixture values used only by `--dry-run`; a real batch must supply its own. */
export const FIXTURE_HMAC_KEY = 'gotry-persona-sim-dry-run-fixture-key-0000'
export const FIXTURE_CONSENT = 'persona-sim dry run: synthetic personas only, no real participant'
export const FIXTURE_CLOCK_START = '2026-10-05T00:00:00.000Z'

export type PersonaSimErrorCode =
  | 'bad_args'
  | 'budget_exceeded'
  | 'capture_failed'
  | 'cost_unprovable'
  | 'fixture_unclassified_prompt'
  | 'internal_error'
  | 'invalid_persona_deck'
  | 'missing_consent'
  | 'missing_hmac_key'
  | 'missing_price_entry'
  | 'persona_contract_violation'
  | 'persona_timeout'
  | 'provider_error'
  | 'unsafe_state_root'

export class PersonaSimError extends Error {
  readonly code: PersonaSimErrorCode

  constructor(code: PersonaSimErrorCode, detail?: string) {
    super(detail ? `${code}: ${detail}` : code)
    this.code = code
  }
}

function fail(code: PersonaSimErrorCode, detail?: string): never {
  throw new PersonaSimError(code, detail)
}

// ---------------------------------------------------------------------------
// Persona deck
// ---------------------------------------------------------------------------

export type AnsweringStyle = 'terse' | 'verbose' | 'evasive'
export type PersonaDecisionKind = 'continue' | 'finalize' | 'abandon'
export type ExpectedOutcome = 'plan_delivered_and_finalized' | 'plan_delivered_not_finalized' | 'interview_only'

export interface PersonaScriptTurn {
  decision: PersonaDecisionKind
  message?: string
  nps?: number
}

export interface PersonaCard {
  persona_id: string
  title: string
  grounding: string
  goals: string[]
  hard_constraints: string[]
  patience: { max_user_turns: number; abandon_after_questions: number }
  answering_style: AnsweringStyle
  finalize_rule: string
  rating_rule: string
  opening_message: string
  expected_outcome: ExpectedOutcome
  dry_run: {
    product_facts: Array<Record<string, unknown>>
    product_skeleton: Record<string, unknown> | null
    product_slots: Record<string, unknown> | null
    persona_turns: PersonaScriptTurn[]
  }
}

const PERSONA_ID = /^[a-z][a-z0-9-]{0,63}$/

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function deckString(value: unknown, label: string, limit = 2048): string {
  if (typeof value !== 'string' || value.trim() === '' || value.length > limit) fail('invalid_persona_deck', label)
  return value
}

function deckStringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length === 0) fail('invalid_persona_deck', label)
  return value.map((item, index) => deckString(item, `${label}[${index}]`))
}

function deckKeys(value: Record<string, unknown>, label: string, keys: readonly string[]): void {
  const expected = new Set(keys)
  for (const key of Object.keys(value)) if (!expected.has(key)) fail('invalid_persona_deck', `${label} has unknown field ${key}`)
  for (const key of keys) if (!(key in value)) fail('invalid_persona_deck', `${label} missing ${key}`)
}

function deckLiteral<T extends string>(value: unknown, label: string, allowed: readonly T[]): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) fail('invalid_persona_deck', label)
  return value as T
}

function deckPositiveInt(value: unknown, label: string, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > max) fail('invalid_persona_deck', label)
  return value
}

function parseScriptTurn(value: unknown, label: string): PersonaScriptTurn {
  if (!isObject(value)) fail('invalid_persona_deck', label)
  for (const key of Object.keys(value)) {
    if (!['decision', 'message', 'nps'].includes(key)) fail('invalid_persona_deck', `${label} has unknown field ${key}`)
  }
  const decision = value['decision']
  if (decision !== 'continue' && decision !== 'finalize' && decision !== 'abandon') fail('invalid_persona_deck', `${label}.decision`)
  const turn: PersonaScriptTurn = { decision }
  if (value['message'] !== undefined) turn.message = deckString(value['message'], `${label}.message`)
  if (value['nps'] !== undefined) {
    const nps = value['nps']
    if (typeof nps !== 'number' || !Number.isInteger(nps) || nps < 0 || nps > 10) fail('invalid_persona_deck', `${label}.nps`)
    turn.nps = nps
  }
  if (decision === 'continue' && turn.message === undefined) fail('invalid_persona_deck', `${label} continue needs a message`)
  return turn
}

export function parsePersonaDeck(raw: unknown): PersonaCard[] {
  if (!isObject(raw)) fail('invalid_persona_deck', 'deck must be an object')
  deckKeys(raw, 'deck', ['schema_version', 'description', 'personas'])
  if (raw['schema_version'] !== PERSONA_DECK_SCHEMA) fail('invalid_persona_deck', 'schema_version')
  deckString(raw['description'], 'deck.description', 4096)
  const personas = raw['personas']
  if (!Array.isArray(personas) || personas.length < 6) fail('invalid_persona_deck', 'deck needs at least 6 personas')
  const seen = new Set<string>()
  const cards = personas.map((value, index) => {
    const label = `personas[${index}]`
    if (!isObject(value)) fail('invalid_persona_deck', label)
    deckKeys(value, label, [
      'persona_id', 'title', 'grounding', 'goals', 'hard_constraints', 'patience',
      'answering_style', 'finalize_rule', 'rating_rule', 'opening_message',
      'expected_outcome', 'dry_run',
    ])
    const personaId = deckString(value['persona_id'], `${label}.persona_id`, 64)
    if (!PERSONA_ID.test(personaId)) fail('invalid_persona_deck', `${label}.persona_id`)
    if (seen.has(personaId)) fail('invalid_persona_deck', `duplicate persona_id ${personaId}`)
    seen.add(personaId)
    const patience = value['patience']
    if (!isObject(patience)) fail('invalid_persona_deck', `${label}.patience`)
    deckKeys(patience, `${label}.patience`, ['max_user_turns', 'abandon_after_questions'])
    const style = deckLiteral<AnsweringStyle>(value['answering_style'], `${label}.answering_style`, ['terse', 'verbose', 'evasive'])
    const outcome = deckLiteral<ExpectedOutcome>(value['expected_outcome'], `${label}.expected_outcome`, [
      'plan_delivered_and_finalized', 'plan_delivered_not_finalized', 'interview_only',
    ])
    const dryRun = value['dry_run']
    if (!isObject(dryRun)) fail('invalid_persona_deck', `${label}.dry_run`)
    deckKeys(dryRun, `${label}.dry_run`, ['product_facts', 'product_skeleton', 'product_slots', 'persona_turns'])
    const facts = dryRun['product_facts']
    if (!Array.isArray(facts) || facts.length === 0 || !facts.every(isObject)) fail('invalid_persona_deck', `${label}.dry_run.product_facts`)
    const skeleton = dryRun['product_skeleton']
    if (skeleton !== null && !isObject(skeleton)) fail('invalid_persona_deck', `${label}.dry_run.product_skeleton`)
    const slots = dryRun['product_slots']
    if (slots !== null && !isObject(slots)) fail('invalid_persona_deck', `${label}.dry_run.product_slots`)
    const turns = dryRun['persona_turns']
    if (!Array.isArray(turns) || turns.length === 0) fail('invalid_persona_deck', `${label}.dry_run.persona_turns`)
    return {
      persona_id: personaId,
      title: deckString(value['title'], `${label}.title`, 256),
      grounding: deckString(value['grounding'], `${label}.grounding`),
      goals: deckStringArray(value['goals'], `${label}.goals`),
      hard_constraints: deckStringArray(value['hard_constraints'], `${label}.hard_constraints`),
      patience: {
        max_user_turns: deckPositiveInt(patience['max_user_turns'], `${label}.patience.max_user_turns`, DEFAULT_MAX_TURNS),
        abandon_after_questions: deckPositiveInt(patience['abandon_after_questions'], `${label}.patience.abandon_after_questions`, DEFAULT_MAX_TURNS),
      },
      answering_style: style,
      finalize_rule: deckString(value['finalize_rule'], `${label}.finalize_rule`),
      rating_rule: deckString(value['rating_rule'], `${label}.rating_rule`),
      opening_message: deckString(value['opening_message'], `${label}.opening_message`),
      expected_outcome: outcome,
      dry_run: {
        product_facts: facts as Array<Record<string, unknown>>,
        product_skeleton: skeleton as Record<string, unknown> | null,
        product_slots: slots as Record<string, unknown> | null,
        persona_turns: turns.map((turn, turnIndex) => parseScriptTurn(turn, `${label}.dry_run.persona_turns[${turnIndex}]`)),
      },
    }
  })
  // Deterministic ordering, independent of file order.
  return cards.sort((a, b) => a.persona_id.localeCompare(b.persona_id))
}

export function loadPersonaDeck(path = DEFAULT_DECK_PATH): PersonaCard[] {
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    fail('invalid_persona_deck', `${path}: ${(error as Error).message}`)
  }
  return parsePersonaDeck(raw)
}

/** The persona system prompt. It is the whole simulated traveller: the provenance digest
 *  recorded with every synthetic record is the SHA-256 of exactly this text. */
export function personaSystemPrompt(card: PersonaCard): string {
  return [
    `${PERSONA_SYSTEM_MARKER} persona=${card.persona_id}`,
    'You are role-playing a traveller talking to a travel planning assistant. You are a simulation, not a real traveller.',
    `Persona: ${card.title}`,
    `Goals:\n${card.goals.map(goal => `- ${goal}`).join('\n')}`,
    `Hard constraints (never violate, never silently drop):\n${card.hard_constraints.map(item => `- ${item}`).join('\n')}`,
    `Answering style: ${card.answering_style}. Patience: at most ${card.patience.max_user_turns} of your own messages; lose interest after ${card.patience.abandon_after_questions} questions with nothing concrete.`,
    `Finalize rule: ${card.finalize_rule}`,
    `Rating rule: ${card.rating_rule}`,
    'Reply ONLY with a JSON object and nothing else:',
    '{"decision":"continue"|"finalize"|"abandon","message":"your next message to the assistant","nps":<integer 0-10 or null>}',
    'Rules: "continue" requires a non-empty message. "finalize" means you accept the delivered plan. "abandon" means you walk away.',
    'Set "nps" to an integer 0-10 only when you finalize or abandon after seeing a plan; otherwise null. Never invent facts outside your constraints.',
  ].join('\n\n')
}

export function promptDigest(card: PersonaCard): string {
  return createHash('sha256').update(personaSystemPrompt(card)).digest('hex')
}

// ---------------------------------------------------------------------------
// Fixture OpenAI-compatible provider (dry run only)
// ---------------------------------------------------------------------------

export interface FixtureProviderHandle {
  url: string
  calls: Record<string, number>
  setPersona(card: PersonaCard): void
  close(): Promise<void>
}

interface FixtureState {
  card: PersonaCard | null
  factsIndex: number
  personaIndex: number
}

const FIXTURE_USAGE = { prompt_tokens: 900, completion_tokens: 180, prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 900, total_tokens: 1080 }

function fixtureBody(model: string, content: string, omitUsage: boolean): string {
  return JSON.stringify({
    id: 'persona-sim-fixture',
    object: 'chat.completion',
    created: 0,
    model,
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    ...(omitUsage ? {} : { usage: { ...FIXTURE_USAGE, total_tokens: FIXTURE_USAGE.prompt_tokens + FIXTURE_USAGE.completion_tokens } }),
  })
}

/**
 * A local OpenAI-compatible endpoint serving scripted replies for BOTH models. Requests are
 * classified by the caller's system prompt; an unclassified prompt is a hard 500 rather than
 * a silent fallback, so a prompt change in `src/dsh-llm.ts` surfaces as a test failure.
 */
export async function startFixtureProvider(options: { omitUsage?: boolean } = {}): Promise<FixtureProviderHandle> {
  const state: FixtureState = { card: null, factsIndex: 0, personaIndex: 0 }
  const calls: Record<string, number> = { facts: 0, skeleton: 0, slots: 0, polish: 0, persona: 0, unclassified: 0 }
  const omitUsage = options.omitUsage === true

  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', chunk => chunks.push(chunk as Buffer))
    request.on('end', () => {
      let kind = 'unclassified'
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
          model?: string
          messages?: Array<{ role: string; content: string }>
        }
        const model = String(body.model ?? 'fixture')
        const system = (body.messages ?? []).filter(message => message.role === 'system').map(message => message.content).join('\n')
        const card = state.card
        if (system.includes(PERSONA_SYSTEM_MARKER)) {
          kind = 'persona'
          if (!card) throw new Error('fixture has no active persona')
          const scripted = card.dry_run.persona_turns[Math.min(state.personaIndex, card.dry_run.persona_turns.length - 1)]!
          state.personaIndex += 1
          const payload = {
            decision: scripted.decision,
            message: scripted.message ?? '',
            nps: scripted.nps ?? null,
          }
          calls[kind] = (calls[kind] ?? 0) + 1
          response.writeHead(200, { 'content-type': 'application/json' })
          response.end(fixtureBody(model, JSON.stringify(payload), omitUsage))
          return
        }
        if (!card) throw new Error('fixture has no active persona')
        let content: string
        if (system.includes('事实抽取器')) {
          kind = 'facts'
          const facts = card.dry_run.product_facts
          content = JSON.stringify(facts[Math.min(state.factsIndex, facts.length - 1)]!)
          state.factsIndex += 1
        } else if (system.includes('行程骨架抽取器')) {
          kind = 'skeleton'
          content = JSON.stringify(card.dry_run.product_skeleton ?? { scenario: 'generic', segments: [] })
        } else if (system.includes('槽位抽取器')) {
          kind = 'slots'
          content = JSON.stringify(card.dry_run.product_slots ?? {})
        } else if (system.includes('润色')) {
          kind = 'polish'
          content = (body.messages ?? []).filter(message => message.role === 'user').map(message => message.content).join('\n')
        } else {
          calls['unclassified'] = (calls['unclassified'] ?? 0) + 1
          response.writeHead(500, { 'content-type': 'application/json' })
          response.end(JSON.stringify({ error: 'fixture_unclassified_prompt', system: system.slice(0, 120) }))
          return
        }
        calls[kind] = (calls[kind] ?? 0) + 1
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(fixtureBody(model, content, omitUsage))
      } catch (error) {
        calls['unclassified'] = (calls['unclassified'] ?? 0) + 1
        response.writeHead(500, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ error: 'fixture_error', detail: (error as Error).message.slice(0, 200) }))
      }
    })
  })

  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen)
    server.listen(0, '127.0.0.1', () => resolveListen())
  })
  const address = server.address()
  if (!address || typeof address === 'string') fail('internal_error', 'fixture provider did not bind a port')

  return {
    url: `http://127.0.0.1:${address.port}/v1`,
    calls,
    setPersona(card: PersonaCard): void {
      state.card = card
      state.factsIndex = 0
      state.personaIndex = 0
    },
    close: () => new Promise<void>(resolveClose => server.close(() => resolveClose())),
  }
}

// ---------------------------------------------------------------------------
// Persona client (OpenAI-compatible, bounded, own usage tracker)
// ---------------------------------------------------------------------------

export interface PersonaDecision {
  decision: PersonaDecisionKind
  message: string
  nps: number | null
}

function emptyUsage(): LlmUsageTracker {
  return { calls: 0, inputTokens: 0, outputTokens: 0, inputCacheHitTokens: 0, inputCacheMissTokens: 0, responsesMissingUsage: 0 }
}

interface PersonaEndpoint {
  baseUrl: string
  apiKey: string
  model: string
  timeoutMs: number
}

function parsePersonaDecision(raw: string, planDelivered: boolean): PersonaDecision {
  const match = raw.match(/\{[\s\S]*\}/)
  if (!match) fail('persona_contract_violation', 'persona reply carried no JSON object')
  let parsed: unknown
  try {
    parsed = JSON.parse(match[0])
  } catch {
    fail('persona_contract_violation', 'persona reply was not valid JSON')
  }
  if (!isObject(parsed)) fail('persona_contract_violation', 'persona reply was not an object')
  for (const key of Object.keys(parsed)) {
    if (!['decision', 'message', 'nps'].includes(key)) fail('persona_contract_violation', `persona reply has unknown field ${key}`)
  }
  const decision = parsed['decision']
  if (decision !== 'continue' && decision !== 'finalize' && decision !== 'abandon') fail('persona_contract_violation', 'persona decision outside the closed set')
  if (decision === 'finalize' && !planDelivered) fail('persona_contract_violation', 'persona finalized before a plan was delivered')
  const message = parsed['message']
  if (typeof message !== 'string' || (decision === 'continue' && message.trim() === '')) fail('persona_contract_violation', 'persona continue needs a message')
  if (message.length > 4096) fail('persona_contract_violation', 'persona message too long')
  const npsRaw = parsed['nps']
  let nps: number | null = null
  if (npsRaw !== null && npsRaw !== undefined) {
    if (typeof npsRaw !== 'number' || !Number.isInteger(npsRaw) || npsRaw < 0 || npsRaw > 10) fail('persona_contract_violation', 'persona nps outside 0..10')
    nps = npsRaw
  }
  if (nps !== null && !planDelivered) fail('persona_contract_violation', 'persona rated a plan it never saw')
  return { decision, message, nps }
}

async function personaDecide(
  endpoint: PersonaEndpoint,
  card: PersonaCard,
  history: Turn[],
  planDelivered: boolean,
  usage: LlmUsageTracker,
): Promise<PersonaDecision> {
  const transcript = history.map(turn => `${turn.role === 'user' ? '你' : '助手'}: ${turn.text}`).join('\n')
  const body = {
    model: endpoint.model,
    messages: [
      { role: 'system', content: personaSystemPrompt(card) },
      {
        role: 'user',
        content: `${planDelivered ? '助手已经给出了方案。' : '助手还没有给出方案。'}\n\n对话记录:\n${transcript}\n\n只输出 JSON。`,
      },
    ],
    response_format: { type: 'json_object' },
    temperature: 0,
  }
  let response: Response
  try {
    response = await fetch(`${endpoint.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${endpoint.apiKey}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(endpoint.timeoutMs),
    })
  } catch (error) {
    const name = (error as Error).name
    if (name === 'TimeoutError' || name === 'AbortError') fail('persona_timeout', `persona model did not answer within ${endpoint.timeoutMs}ms`)
    fail('provider_error', `persona model transport failure: ${name}`)
  }
  if (!response.ok) fail('provider_error', `persona model returned ${response.status}`)
  const data = await response.json() as {
    choices?: Array<{ message?: { content?: string } }>
    usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_cache_hit_tokens?: number; prompt_cache_miss_tokens?: number }
  }
  usage.calls += 1
  const reported = data.usage
  if (reported && Number.isFinite(reported.prompt_tokens) && Number.isFinite(reported.completion_tokens)) {
    usage.inputTokens += reported.prompt_tokens ?? 0
    usage.outputTokens += reported.completion_tokens ?? 0
    usage.inputCacheHitTokens += reported.prompt_cache_hit_tokens ?? 0
    usage.inputCacheMissTokens += reported.prompt_cache_miss_tokens ?? (reported.prompt_tokens ?? 0)
  } else {
    usage.responsesMissingUsage += 1
  }
  const content = data.choices?.[0]?.message?.content ?? ''
  return parsePersonaDecision(content.replace(/<think>[\s\S]*?<\/think>/g, '').trim() || content, planDelivered)
}

// ---------------------------------------------------------------------------
// POI / bookable-claim audit, derived from the product's own fact gate
// ---------------------------------------------------------------------------

/**
 * Gate violation kinds where the artifact asserts something the fact registry actively
 * contradicts. These — and only these — are counted as invalid claims.
 *
 * `route_unqueried` / `*_unverified` are deliberately NOT here: an unverified claim is not a
 * hallucination, and in a simulated run the registry is empty, so every claim is unverified.
 * See docs/evaluation/persona-sim-report.md §4 for what this can and cannot mean.
 */
export const CONTRADICTION_KINDS: ReadonlySet<string> = new Set([
  'not_in_source',
  'contradicted',
  'airport_mapping_conflict',
  'price_contradicted',
  'fact_anchor_unknown',
  'unconditional_check',
  'self_transfer_called_through',
  'nights_inconsistent',
  'legs_inconsistent',
  'budget_floor_inconsistent',
  'date_order',
])

export interface PoiAudit {
  /** Audited denominator: only claims the gate could actually adjudicate. */
  locked_claims: number
  invalid_claims: number
  claims_extracted: number
  traceable_claims: number
  unverified_claims: number
  gate_verdict: 'pass' | 'blocked'
  presentation: string
  violation_kinds: Record<string, number>
}

/**
 * `locked_claims` is the *audited* denominator, not the extracted claim count.
 *
 * Counting every extracted claim as audited was wrong: with an empty registry a plan whose
 * claims are all `route_unqueried` would record 0/N and the scorer would print a 0% POI
 * rate with `pass=true` — an unaudited plan scoring as a clean one. A claim is only part of
 * the denominator when the registry could adjudicate it, i.e. it came back traceable or
 * contradicted. An empty registry therefore yields `locked_claims=0`, which the scorer
 * reports as `unavailable` with `pass=false`, which is the truth.
 */
export function poiAuditFromGateReport(report: {
  verdict?: unknown
  claims_checked?: unknown
  traceable?: unknown
  presentation?: unknown
  violations?: unknown
}): PoiAudit {
  const extracted = typeof report.claims_checked === 'number' ? report.claims_checked : 0
  const traceable = typeof report.traceable === 'number' ? report.traceable : 0
  const violations = Array.isArray(report.violations) ? report.violations as Array<{ kind?: unknown }> : []
  const kinds: Record<string, number> = {}
  let contradicted = 0
  for (const violation of violations) {
    const kind = String(violation.kind ?? 'unknown')
    kinds[kind] = (kinds[kind] ?? 0) + 1
    if (CONTRADICTION_KINDS.has(kind)) contradicted += 1
  }
  const invalid = Math.min(contradicted, extracted)
  const locked = Math.min(traceable + invalid, extracted)
  return {
    locked_claims: locked,
    invalid_claims: Math.min(invalid, locked),
    claims_extracted: extracted,
    traceable_claims: traceable,
    unverified_claims: Math.max(extracted - locked, 0),
    gate_verdict: report.verdict === 'pass' ? 'pass' : 'blocked',
    presentation: String(report.presentation ?? 'verified_label_forbidden'),
    violation_kinds: kinds,
  }
}

// ---------------------------------------------------------------------------
// Session driver
// ---------------------------------------------------------------------------

interface RegisteredTool {
  name: string
  execute: (args: Record<string, unknown>, exec: unknown) => Promise<unknown>
}

/** Mount the real product tools against an isolated stateRoot, the way smoke.ts does. */
function mountProductTools(stateRoot: string): Map<string, RegisteredTool> {
  const registered = new Map<string, RegisteredTool>()
  const ctx = {
    tools: { register: (tool: unknown) => { const typed = tool as RegisteredTool; registered.set(typed.name, typed) } },
    systemPrompt: { variable: () => {} },
    get: () => undefined,
    on: () => () => {},
  } as unknown as Context
  apply(ctx, { stateRoot, timeoutMs: 15_000, hbcliBin: 'hbcli-not-on-path', sessionAccess: 'deny' } as never)
  return registered
}

/** The delivered artifact: the candidate solver's own markdown when the scenario produced
 *  one, otherwise the deterministic plan renderer. */
export function deliveredPlanMarkdown(state: TripState): string | null {
  const solve = state.solve as Record<string, unknown> | undefined
  if (!solve) return null
  if (typeof solve['answer_md'] === 'string' && solve['answer_md'].trim() !== '') return solve['answer_md'] as string
  const rendered = renderSolve(state)
  return rendered.trim() === '' || rendered === '(无求解结果)' ? null : rendered
}

export interface PersonaRunOutcome {
  persona_id: string
  expected_outcome: ExpectedOutcome
  user_turns: number
  plan_delivered: boolean
  finalized: boolean
  abandoned: boolean
  nps: number | null
  /** `solver_error` is its own class, never folded into `infeasible` (issue #620): the
   *  solver failing is not a verdict about the trip, and counting it as an infeasibility
   *  would make the harness report an engine defect as a product answer. */
  solver_verdict: 'feasible' | 'infeasible' | 'candidate_choice' | 'solver_error' | 'none'
  unsat_core: string[]
  /** Machine code of the solver failure (`solver_input_not_integer` / `solver_runtime_error`),
   *  null whenever the solver produced an actual verdict. Never a user-facing string. */
  solver_error_code: string | null
  poi_audit: PoiAudit | null
  plan_markdown_sha256: string | null
  product_usage: LlmUsageTracker
  persona_usage: LlmUsageTracker
  error: { code: PersonaSimErrorCode; detail: string } | null
}

function solverVerdict(state: TripState): { verdict: PersonaRunOutcome['solver_verdict']; unsat: string[]; errorCode: string | null } {
  const solve = state.solve as Record<string, unknown> | undefined
  if (!solve) return { verdict: 'none', unsat: [], errorCode: null }
  if (typeof solve['answer_md'] === 'string') return { verdict: 'candidate_choice', unsat: [], errorCode: null }
  // issue #620: a solver failure is classified before `feasible` is read at all. The solver
  // crashing says nothing about the trip, so it must not be counted as an infeasibility.
  const solverError = solve['solver_error'] as { code?: unknown } | undefined
  if (solverError && typeof solverError === 'object') {
    return { verdict: 'solver_error', unsat: [], errorCode: String(solverError.code ?? 'unknown') }
  }
  const unsat = Array.isArray(solve['unsat_core']) ? (solve['unsat_core'] as unknown[]).map(String) : []
  return { verdict: solve['feasible'] === true ? 'feasible' : 'infeasible', unsat, errorCode: null }
}

async function withDeadline<T>(promise: Promise<T>, ms: number, code: PersonaSimErrorCode, detail: string): Promise<T> {
  // A loser promise that rejects after the race would otherwise surface as an unhandled
  // rejection, so it is defused before the race starts.
  promise.catch(() => {})
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolveRace, rejectRace) => {
        timer = setTimeout(() => rejectRace(new PersonaSimError(code, detail)), ms)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export interface SessionOptions {
  card: PersonaCard
  stateRoot: string
  personaEndpoint: PersonaEndpoint
  packPath: string
  clock: Clock
  maxTurns: number
  /** Caller-owned usage trackers: a session that times out must still have its spend
   *  counted by the budget gate, so the counters live outside the session. */
  productUsage: LlmUsageTracker
  personaUsage: LlmUsageTracker
  /** Called after every turn with this session's spend so far. Throws `budget_exceeded` to
   *  stop mid-session; the per-turn granularity is the finest the usage API allows, since a
   *  tracker only moves when a request returns. */
  checkBudget: (sessionCostUsd: number) => void
  /** Prices this session's spend so far from the two caller-owned trackers. */
  sessionCost: () => number
}

async function runPersonaSession(options: SessionOptions): Promise<PersonaRunOutcome> {
  const { card, personaEndpoint, clock, productUsage, personaUsage } = options
  const outcome: PersonaRunOutcome = {
    persona_id: card.persona_id,
    expected_outcome: card.expected_outcome,
    user_turns: 0,
    plan_delivered: false,
    finalized: false,
    abandoned: false,
    nps: null,
    solver_verdict: 'none',
    unsat_core: [],
    solver_error_code: null,
    poi_audit: null,
    plan_markdown_sha256: null,
    product_usage: productUsage,
    persona_usage: personaUsage,
    error: null,
  }

  const tools = mountProductTools(options.stateRoot)
  const factGate = tools.get('gotry_fact_gate')
  if (!factGate) fail('internal_error', 'gotry_fact_gate is not registered — the product tool surface changed')

  const now = clock.now()
  const port: LlmPort & { usage?: LlmUsageTracker } = createOpenAICompatLlm(options.packPath, () => now)
  const syncProductUsage = (): void => {
    const tracked = (port as { usage?: LlmUsageTracker }).usage
    if (tracked) Object.assign(productUsage, tracked)
  }
  const solvePort = realtimeSolvePort(solveUnified)
  const state = newState()
  const history: Turn[] = []
  const maxTurns = Math.min(options.maxTurns, card.patience.max_user_turns)

  let message: string | null = card.opening_message
  for (let turn = 0; turn < maxTurns && message !== null; turn += 1) {
    const userMessage: string = message
    try {
      const { reply } = await runTurn(state, userMessage, port as LlmPort, [...history], solvePort as never, now)
      syncProductUsage()
      history.push({ role: 'user', text: userMessage }, { role: 'assistant', text: reply })
      outcome.user_turns += 1

      const planMarkdown = deliveredPlanMarkdown(state)
      if (planMarkdown !== null && !outcome.plan_delivered) {
        outcome.plan_delivered = true
        outcome.plan_markdown_sha256 = createHash('sha256').update(planMarkdown).digest('hex')
        const verdict = solverVerdict(state)
        outcome.solver_verdict = verdict.verdict
        outcome.unsat_core = verdict.unsat
        outcome.solver_error_code = verdict.errorCode
        // The product's own registered fact gate, reading this session's isolated registry.
        const report = await factGate.execute({ markdown: planMarkdown, tripYear: 2026 }, null) as Record<string, unknown>
        outcome.poi_audit = poiAuditFromGateReport(report)
      }

      const decision = await personaDecide(personaEndpoint, card, history, outcome.plan_delivered, personaUsage)
      if (decision.nps !== null) outcome.nps = decision.nps
      if (decision.decision === 'finalize') {
        outcome.finalized = true
        message = null
      } else if (decision.decision === 'abandon') {
        outcome.abandoned = true
        message = null
      } else {
        message = decision.message
      }
      // Budget is enforced between turns, not only between sessions: two concurrent
      // sessions could otherwise both run to completion past the limit.
      options.checkBudget(options.sessionCost())
    } catch (error) {
      syncProductUsage()
      // A broken persona contract or a provider failure ends this session without
      // discarding what already happened: the partial funnel is the measurement.
      outcome.error = {
        code: error instanceof PersonaSimError ? error.code : 'internal_error',
        detail: (error as Error).message.slice(0, 300),
      }
      message = null
    }
  }

  syncProductUsage()
  return outcome
}

// ---------------------------------------------------------------------------
// Batch
// ---------------------------------------------------------------------------

export interface PersonaBatchOptions {
  deckPath?: string
  dryRun: boolean
  stateRoot?: string
  evidenceRoot?: string
  budgetUsd?: number
  maxTurns?: number
  concurrency?: number
  personaFilter?: string[]
  consent?: string
  hmacKey?: string
  clock?: Clock
  keep?: boolean
  sessionDeadlineMs?: number
  /** Test seam: inject an already-running fixture provider instead of starting one. */
  fixture?: FixtureProviderHandle
  omitFixtureUsage?: boolean
}

/**
 * Funnel arithmetic computed by the harness itself.
 *
 * It has to be: simulated participants are enrolled `test_or_staff=true`, so the scorer
 * excludes every one of them and its own funnel fields come back `unavailable`. That
 * exclusion is the point — it is what keeps simulated records out of the eligible set at
 * record level — so the numbers a reader wants about the simulation are computed here, over
 * the harness's own outcomes, using the scorer's formulas.
 */
export interface PersonaFunnelSummary {
  schema: 'gotry_persona_sim_funnel.v1'
  personas_run: number
  errored: number
  delivered: number
  finalized: number
  /** finalized / delivered, or null when the denominator is 0 (never 0% on an empty set). */
  finalization_rate: number | null
  nps_responses: number
  promoters: number
  passives: number
  detractors: number
  nps_score: number | null
  claims_extracted: number
  locked_claims: number
  invalid_claims: number
  /** invalid / locked, or null when nothing was audited. */
  poi_rate: number | null
}

export function summarizeFunnel(outcomes: readonly PersonaRunOutcome[]): PersonaFunnelSummary {
  const round = (value: number): number => Number(value.toFixed(6))
  const delivered = outcomes.filter(outcome => outcome.plan_delivered)
  const finalized = delivered.filter(outcome => outcome.finalized)
  const scores = delivered.map(outcome => outcome.nps).filter((score): score is number => score !== null)
  const promoters = scores.filter(score => score >= 9).length
  const detractors = scores.filter(score => score <= 6).length
  const claimsExtracted = delivered.reduce((sum, outcome) => sum + (outcome.poi_audit?.claims_extracted ?? 0), 0)
  const locked = delivered.reduce((sum, outcome) => sum + (outcome.poi_audit?.locked_claims ?? 0), 0)
  const invalid = delivered.reduce((sum, outcome) => sum + (outcome.poi_audit?.invalid_claims ?? 0), 0)
  return {
    schema: 'gotry_persona_sim_funnel.v1',
    personas_run: outcomes.length,
    errored: outcomes.filter(outcome => outcome.error !== null).length,
    delivered: delivered.length,
    finalized: finalized.length,
    finalization_rate: delivered.length === 0 ? null : round(finalized.length / delivered.length),
    nps_responses: scores.length,
    promoters,
    passives: scores.length - promoters - detractors,
    detractors,
    nps_score: scores.length === 0 ? null : round(100 * (promoters - detractors) / scores.length),
    claims_extracted: claimsExtracted,
    locked_claims: locked,
    invalid_claims: invalid,
    poi_rate: locked === 0 ? null : round(invalid / locked),
  }
}

export interface PersonaBatchResult {
  schema: 'gotry_persona_sim_result.v1'
  state: 'waiting_external_evidence' | 'dry_run_complete' | 'evidence_written'
  reason?: string
  evidence_kind: 'synthetic_fixture'
  product_model: string | null
  persona_model: string | null
  real_llm: boolean
  budget_usd: number
  cost_usd: number
  real_spend_usd: number
  cost_over_budget: boolean
  personas: PersonaRunOutcome[]
  funnel: PersonaFunnelSummary
  evidence_root: string | null
  scorer_summary: M3ProductMetricsSummary | null
  verification: { evidence_kind: string; record_count: number; simulated_record_count: number } | null
  fixture_calls: Record<string, number> | null
}

function envValue(name: string): string | undefined {
  const value = process.env[name]
  return value !== undefined && value.trim() !== '' ? value : undefined
}

function steppingClock(startIso: string): Clock {
  let ms = Date.parse(startIso)
  return { now: () => { ms += 1_000; return new Date(ms) } }
}

function assertModelPriced(model: string, table: LlmPriceTable): void {
  try {
    priceRunCost(model, emptyUsage(), table)
  } catch (error) {
    fail('missing_price_entry', `${model}: ${(error as Error).message}`)
  }
}

function usageCost(model: string, usage: LlmUsageTracker, table: LlmPriceTable): number {
  if (usage.calls === 0) return 0
  if (usage.responsesMissingUsage > 0) {
    fail('cost_unprovable', `${model} omitted usage on ${usage.responsesMissingUsage} response(s) — refusing to price`)
  }
  return priceRunCost(model, usage, table)
}

/** Scrub the environment the sessions run in: no live POI backend, no realtime pricing,
 *  no inherited provider endpoint. Restored by the returned function. */
function scrubSessionEnv(patch: Record<string, string | undefined>, sandbox: string): () => void {
  const binDir = join(sandbox, 'empty-bin')
  mkdirSync(binDir, { recursive: true })
  const full: Record<string, string | undefined> = {
    PATH: binDir,
    HOME: sandbox,
    GOTRY_REALTIME_PRICING: undefined,
    GOTRY_SESSION_LIVE: '0',
    GOTRY_HBCLI_LIVE: '0',
    ...patch,
  }
  const saved = new Map<string, string | undefined>()
  for (const [key, value] of Object.entries(full)) {
    saved.set(key, process.env[key])
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  return () => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

export async function runPersonaBatch(options: PersonaBatchOptions): Promise<PersonaBatchResult> {
  const deck = loadPersonaDeck(options.deckPath)
  const selected = options.personaFilter && options.personaFilter.length > 0
    ? deck.filter(card => options.personaFilter!.includes(card.persona_id))
    : deck
  if (selected.length === 0) fail('bad_args', 'persona filter matched no card')

  const productKey = envValue('LLM_API_KEY') ?? envValue('DEEPSEEK_API_KEY')
  const budgetUsd = options.budgetUsd ?? Number(envValue('GOTRY_PERSONA_BUDGET_USD') ?? DEFAULT_BUDGET_USD)
  if (!Number.isFinite(budgetUsd) || budgetUsd <= 0) fail('bad_args', 'GOTRY_PERSONA_BUDGET_USD must be a positive number')

  if (!options.dryRun && !productKey) {
    // Same stop rule as nightly-evidence.ts: wait, back off, spend nothing, write nothing.
    return {
      schema: 'gotry_persona_sim_result.v1',
      state: 'waiting_external_evidence',
      reason: 'no real LLM credential (LLM_API_KEY/DEEPSEEK_API_KEY) in the environment; waiting, no spend, no writes',
      evidence_kind: 'synthetic_fixture',
      product_model: null,
      persona_model: null,
      real_llm: false,
      budget_usd: budgetUsd,
      cost_usd: 0,
      real_spend_usd: 0,
      cost_over_budget: false,
      personas: [],
      funnel: summarizeFunnel([]),
      evidence_root: null,
      scorer_summary: null,
      verification: null,
      fixture_calls: null,
    }
  }

  const priceTable = loadPriceTable(join(TS_ROOT, 'data', 'llm-price-table.json'))
  const productModel = envValue('LLM_MODEL') ?? envValue('DEEPSEEK_MODEL') ?? 'MiniMax-M2'
  const personaModel = envValue('GOTRY_PERSONA_MODEL') ?? productModel
  // Fail-closed before any spend: an unpriced model makes cost unprovable.
  assertModelPriced(productModel, priceTable)
  assertModelPriced(personaModel, priceTable)

  const consent = options.consent ?? (options.dryRun ? FIXTURE_CONSENT : envValue('GOTRY_PERSONA_CONSENT'))
  if (!consent) fail('missing_consent', 'a real batch needs --consent (or GOTRY_PERSONA_CONSENT)')
  const hmacKey = options.hmacKey ?? envValue('GOTRY_M3_COHORT_HMAC_KEY') ?? (options.dryRun ? FIXTURE_HMAC_KEY : undefined)
  if (!hmacKey) fail('missing_hmac_key', 'a real batch needs GOTRY_M3_COHORT_HMAC_KEY')

  // A real batch costs money, so its evidence must not land in a temp root this function
  // then deletes: both destinations have to be chosen by the caller.
  if (!options.dryRun && (options.stateRoot === undefined || options.evidenceRoot === undefined)) {
    fail('bad_args', 'a real batch needs both --state-root and --evidence-root so the evidence survives the run')
  }
  const ownsRoot = options.stateRoot === undefined
  const batchRoot = options.stateRoot ?? mkdtempSync(join(tmpdir(), 'gotry-persona-sim-'))
  // The capture core enforces the state-root policy, but only once it is asked to write —
  // by then the harness would already have mkdir'd its sandbox and capture dir inside a
  // forbidden root. Apply the same policy here, before any directory is created.
  try {
    assertSafeStateRoot(batchRoot)
  } catch (error) {
    if (error instanceof M3CohortError && error.code === 'unsafe_state_root') fail('unsafe_state_root', batchRoot)
    fail('bad_args', `unusable --state-root: ${(error as Error).message}`)
  }
  const captureRoot = join(batchRoot, 'capture')
  const evidenceRoot = options.evidenceRoot ?? join(batchRoot, 'evidence')
  const clock = options.clock ?? (options.dryRun ? steppingClock(FIXTURE_CLOCK_START) : { now: () => new Date() })
  const maxTurns = Math.min(options.maxTurns ?? DEFAULT_MAX_TURNS, DEFAULT_MAX_TURNS)
  // The fixture provider keeps one active persona at a time, so any fixture-backed batch
  // is serialized regardless of the requested concurrency.
  const concurrency = options.dryRun || options.fixture
    ? 1
    : Math.max(1, Math.min(options.concurrency ?? 1, MAX_CONCURRENCY))
  const sessionDeadlineMs = options.sessionDeadlineMs ?? 180_000

  let fixture: FixtureProviderHandle | null = options.fixture ?? null
  let ownsFixture = false
  let restoreEnv: (() => void) | null = null
  const outcomes: PersonaRunOutcome[] = []
  let costUsd = 0
  let overBudget = false

  try {
    if (options.dryRun && !fixture) {
      fixture = await startFixtureProvider({ omitUsage: options.omitFixtureUsage })
      ownsFixture = true
    }
    restoreEnv = scrubSessionEnv(
      fixture
        ? { LLM_BASE_URL: fixture.url, LLM_API_KEY: 'persona-sim-fixture-token', LLM_MODEL: productModel, DEEPSEEK_BASE_URL: undefined, DEEPSEEK_API_KEY: undefined, DEEPSEEK_MODEL: undefined }
        : {},
      batchRoot,
    )

    const personaEndpointBase = fixture?.url ?? envValue('GOTRY_PERSONA_BASE_URL') ?? envValue('LLM_BASE_URL') ?? 'https://api.minimax.io/v1'
    const personaEndpoint: PersonaEndpoint = {
      baseUrl: personaEndpointBase,
      apiKey: fixture ? 'persona-sim-fixture-token' : (envValue('GOTRY_PERSONA_API_KEY') ?? productKey ?? ''),
      model: personaModel,
      timeoutMs: 60_000,
    }

    mkdirSync(captureRoot, { recursive: true })
    const captureCommon = { stateRoot: captureRoot, consent, hmacKey }
    const windowStart = new Date(Date.parse(clock.now().toISOString()) - 86_400_000).toISOString()
    initM3Cohort({
      ...captureCommon,
      // Bounded label: the deck can grow, the cohort handle must not.
      cohort: `persona-sim:${createHash('sha256').update(selected.map(card => card.persona_id).join(',')).digest('hex').slice(0, 32)}`,
      evidenceKind: 'synthetic_fixture',
      windowStartAt: windowStart,
      windowEndAt: new Date(Date.parse(windowStart) + 30 * 86_400_000).toISOString(),
      timezone: 'UTC',
      allowedAttribution: ['gotry_primary'],
    }, clock)

    // Capture writes are serialized: the capture store holds an exclusive writer lock, and
    // a concurrent session must never turn into a `lock_busy` data loss.
    let captureChain: Promise<void> = Promise.resolve()
    const capture = (body: () => void): Promise<void> => {
      captureChain = captureChain.then(() => { body() })
      return captureChain
    }

    const queue = [...selected]
    const runNext = async (): Promise<void> => {
      for (;;) {
        if (overBudget) return
        const card = queue.shift()
        if (!card) return
        const sessionRoot = join(batchRoot, 'sessions', card.persona_id)
        mkdirSync(sessionRoot, { recursive: true })
        if (fixture) fixture.setPersona(card)
        // The trackers are owned here so a timed-out session still reports its spend.
        const productUsage = emptyUsage()
        const personaUsage = emptyUsage()
        const sessionCost = (): number => usageCost(productModel, productUsage, priceTable) + usageCost(personaModel, personaUsage, priceTable)
        let outcome: PersonaRunOutcome
        try {
          outcome = await withDeadline(
            runPersonaSession({
              card,
              stateRoot: sessionRoot,
              personaEndpoint,
              packPath: join(REPO_ROOT, 'data', 'flights_2026.json'),
              clock,
              maxTurns,
              productUsage,
              personaUsage,
              sessionCost,
              checkBudget: (thisSession: number) => {
                if (Number((costUsd + thisSession).toFixed(6)) > budgetUsd) {
                  overBudget = true
                  fail('budget_exceeded', `running total exceeds GOTRY_PERSONA_BUDGET_USD ${budgetUsd}`)
                }
              },
            }),
            sessionDeadlineMs,
            'persona_timeout',
            `persona ${card.persona_id} exceeded ${sessionDeadlineMs}ms`,
          )
        } catch (error) {
          const code = error instanceof PersonaSimError ? error.code : 'internal_error'
          outcome = {
            persona_id: card.persona_id,
            expected_outcome: card.expected_outcome,
            user_turns: 0,
            plan_delivered: false,
            finalized: false,
            abandoned: false,
            nps: null,
            solver_verdict: 'none',
            unsat_core: [],
            solver_error_code: null,
            poi_audit: null,
            plan_markdown_sha256: null,
            product_usage: productUsage,
            persona_usage: personaUsage,
            error: { code, detail: (error as Error).message.slice(0, 300) },
          }
        }
        outcomes.push(outcome)

        // Only a delivered plan with a locked claim audit becomes a cohort record; an
        // interview-only or failed session contributes nothing, exactly as a real funnel
        // would record it.
        if (outcome.error === null && outcome.plan_delivered && outcome.poi_audit) {
          const provenance: M3SimulationProvenance = {
            schema_version: M3_SIMULATION_PROVENANCE_SCHEMA,
            kind: 'llm_persona',
            persona_id: card.persona_id,
            product_model: productModel,
            persona_model: personaModel,
            prompt_digest: promptDigest(card),
          }
          const participant = `persona:${card.persona_id}`
          const plan = `persona:${card.persona_id}:plan`
          // test_or_staff=true is deliberate and is the record-level half of the
          // never-counts guarantee: the scorer's own `test_or_staff` exclusion drops every
          // simulated participant, so even a relabelled manifest yields sample=0 and
          // business_pass=false. The funnel numbers a reader wants are therefore computed
          // by summarizeFunnel() over the harness's outcomes, not read off the scorer.
          try {
            await capture(() => {
              enrollParticipant({ ...captureCommon, participant, invited: true, participantConsent: true, testOrStaff: true, simulation: provenance }, clock)
              recordPlanDelivered({ ...captureCommon, participant, plan, attribution: 'gotry_primary' }, clock)
              if (outcome.finalized) recordPlanFinalized({ ...captureCommon, participant, plan }, clock)
              if (outcome.nps !== null) recordNps({ ...captureCommon, participant, plan, score: outcome.nps }, clock)
              recordPoiLock({
                ...captureCommon,
                participant,
                plan,
                lockedClaims: outcome.poi_audit!.locked_claims,
                invalidClaims: outcome.poi_audit!.invalid_claims,
              }, clock)
            })
          } catch (error) {
            // Same granularity as a failed session: one unrecordable persona is reported on
            // that persona and the paid batch still exports everything else.
            captureChain = Promise.resolve()
            outcome.error = { code: 'capture_failed', detail: (error as Error).message.slice(0, 300) }
          }
        }

        costUsd = Number((costUsd
          + usageCost(productModel, outcome.product_usage, priceTable)
          + usageCost(personaModel, outcome.persona_usage, priceTable)).toFixed(6))
        if (costUsd > budgetUsd) {
          overBudget = true
          return
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, runNext))
    await captureChain.catch(() => {})

    // An over-budget batch still exports: the spend already happened and the captured
    // records are facts about it. The batch reports cost_over_budget and the CLI exits 3.
    const { payload } = exportM3Cohort({ ...captureCommon, evidenceRoot }, clock)
    const manifest = parseManifest(JSON.parse(JSON.stringify(payload.manifest)))
    const cohort = payload.cohort.map((record, index) => parseCohortRecord(JSON.parse(JSON.stringify(record)), index))
    const summary = scoreProductMetrics(manifest, cohort, [])
    const verification = verifyExportedEvidence(evidenceRoot, hmacKey)
    if (summary.business_pass) fail('internal_error', 'a synthetic export must never reach business_pass')
    if (summary.sample.participants !== 0) {
      fail('internal_error', 'simulated participants must be excluded from the scorer eligible set')
    }

    return {
      schema: 'gotry_persona_sim_result.v1',
      state: options.dryRun ? 'dry_run_complete' : 'evidence_written',
      reason: overBudget ? `cost_usd ${costUsd} exceeds GOTRY_PERSONA_BUDGET_USD ${budgetUsd} — batch stopped early` : undefined,
      evidence_kind: 'synthetic_fixture',
      product_model: productModel,
      persona_model: personaModel,
      real_llm: !options.dryRun,
      budget_usd: budgetUsd,
      cost_usd: costUsd,
      real_spend_usd: options.dryRun ? 0 : costUsd,
      cost_over_budget: overBudget,
      personas: outcomes.sort((a, b) => a.persona_id.localeCompare(b.persona_id)),
      funnel: summarizeFunnel(outcomes),
      evidence_root: evidenceRoot,
      scorer_summary: summary,
      verification: {
        evidence_kind: verification.evidence_kind,
        record_count: verification.record_count,
        simulated_record_count: verification.simulated_record_count,
      },
      fixture_calls: fixture ? { ...fixture.calls } : null,
    }
  } finally {
    if (restoreEnv) restoreEnv()
    if (ownsFixture && fixture) await fixture.close()
    if (ownsRoot && options.keep !== true) rmSync(batchRoot, { recursive: true, force: true })
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  if (index < 0) return undefined
  const value = process.argv[index + 1]
  if (value === undefined || value.startsWith('--')) throw new PersonaSimError('bad_args', `${name} needs a value`)
  return value
}

function renderMarkdown(result: PersonaBatchResult): string {
  const lines = [
    `# persona-sim (${result.state}) — SYNTHETIC ONLY, never M3/M4 evidence`,
    '',
    `- models: product=${result.product_model ?? '-'} persona=${result.persona_model ?? '-'} real_llm=${result.real_llm}`,
    `- cost: computed $${result.cost_usd} / budget $${result.budget_usd} (real spend $${result.real_spend_usd}${result.cost_over_budget ? ', OVER BUDGET' : ''})`,
    `- evidence root: ${result.evidence_root ?? '(none written)'}`,
  ]
  if (result.reason) lines.push(`- reason: ${result.reason}`)
  if (result.personas.length > 0) {
    lines.push('', '| persona | turns | delivered | finalized | nps | solver | extracted | audited | invalid | gate | error |', '|---|---|---|---|---|---|---|---|---|---|---|')
    for (const persona of result.personas) {
      lines.push(`| ${persona.persona_id} | ${persona.user_turns} | ${persona.plan_delivered} | ${persona.finalized} | ${persona.nps ?? '-'} `
        + `| ${persona.solver_verdict}${persona.solver_error_code ? `(${persona.solver_error_code})` : persona.unsat_core.length ? `(${persona.unsat_core.join(',')})` : ''} `
        + `| ${persona.poi_audit?.claims_extracted ?? '-'} | ${persona.poi_audit?.locked_claims ?? '-'} | ${persona.poi_audit?.invalid_claims ?? '-'} `
        + `| ${persona.poi_audit?.gate_verdict ?? '-'} | ${persona.error ? persona.error.code : '-'} |`)
    }
  }
  const funnel = result.funnel
  lines.push('', `- harness funnel (simulation, computed here): delivered=${funnel.delivered}/${funnel.personas_run} `
    + `finalized=${funnel.finalized} finalization=${funnel.finalization_rate ?? 'unavailable'} `
    + `nps=${funnel.nps_score ?? 'unavailable'}(n=${funnel.nps_responses}) `
    + `claims extracted=${funnel.claims_extracted} audited=${funnel.locked_claims} invalid=${funnel.invalid_claims} `
    + `poi=${funnel.poi_rate ?? 'unavailable'} errored=${funnel.errored}`)
  const summary = result.scorer_summary
  if (summary) {
    lines.push(`- scorer (excludes every simulated participant via test_or_staff): participants=${summary.sample.participants} `
      + `finalization=${summary.finalization.rate ?? 'unavailable'} nps=${summary.nps.score ?? 'unavailable'} `
      + `poi=${summary.poi_hallucination.rate ?? 'unavailable'} test_or_staff_excluded=${summary.exclusions['test_or_staff'] ?? 0}`)
    lines.push(`- business_pass: ${summary.business_pass} — ${summary.business_pass_reason}`)
  }
  return lines.join('\n')
}

async function main(): Promise<void> {
  // `--format` is read inside the try: a malformed flag must surface as bad_args, not as an
  // unhandled rejection before the error path exists.
  let asJson = process.argv.includes('--format')
  try {
    asJson = (arg('--format') ?? 'markdown') === 'json'
    const result = await runPersonaBatch({
      deckPath: arg('--deck'),
      dryRun: process.argv.includes('--dry-run'),
      stateRoot: arg('--state-root'),
      evidenceRoot: arg('--evidence-root'),
      budgetUsd: arg('--budget-usd') === undefined ? undefined : Number(arg('--budget-usd')),
      maxTurns: arg('--max-turns') === undefined ? undefined : Number(arg('--max-turns')),
      concurrency: arg('--concurrency') === undefined ? undefined : Number(arg('--concurrency')),
      personaFilter: arg('--persona') === undefined ? undefined : arg('--persona')!.split(','),
      consent: arg('--consent'),
      keep: process.argv.includes('--keep'),
    })
    if (asJson) console.log(JSON.stringify(result, null, 2))
    else console.log(renderMarkdown(result))
    if (result.cost_over_budget) process.exitCode = 3
  } catch (error) {
    const code = error instanceof PersonaSimError ? error.code : 'internal_error'
    const payload = { schema: 'gotry_persona_sim_result.v1', state: 'error', code, detail: (error as Error).message.slice(0, 400) }
    if (asJson) console.log(JSON.stringify(payload, null, 2))
    else console.log(`persona-sim error: ${code} — ${payload.detail}`)
    process.exitCode = 1
  }
}

if (process.argv[1]?.endsWith('persona-sim.ts')) {
  await main()
}
