#!/usr/bin/env tsx
/**
 * Explicit opt-in M3 seed-cohort capture CLI (issue #22).
 *
 * Produces the records `scripts/product-metrics.ts` consumes. The scorer is the only
 * component that divides anything; this CLI only records funnel facts and then hands the
 * written evidence root straight back to the scorer for verification.
 *
 * The production CLI intentionally has no `--at` flag: timestamps come from the local
 * clock. Tests inject clocks through `../src/m3-cohort.ts`.
 *
 * HMAC key custody: `GOTRY_M3_COHORT_HMAC_KEY` (>= 32 chars) lives outside the repository
 * and is never printed by this CLI. Losing it makes the store unreadable by design.
 *
 *   npx tsx scripts/m3-cohort.ts init --state-root "$ROOT" --consent "$C" \
 *     --cohort m3-seed --evidence-kind real_seed_cohort \
 *     --window-start 2026-10-01T00:00:00.000Z --window-end 2026-12-31T23:59:59.000Z \
 *     --timezone Asia/Shanghai --attribution gotry_primary
 *   npx tsx scripts/m3-cohort.ts enroll   ... --participant <handle> --invited --participant-consent
 *   npx tsx scripts/m3-cohort.ts deliver  ... --participant <handle> --plan <handle> --attribution gotry_primary
 *   npx tsx scripts/m3-cohort.ts finalize ... --participant <handle> --plan <handle>
 *   npx tsx scripts/m3-cohort.ts nps      ... --participant <handle> --plan <handle> --score 9
 *   npx tsx scripts/m3-cohort.ts poi-lock ... --participant <handle> --plan <handle> --locked-claims 12 --invalid-claims 0
 *   npx tsx scripts/m3-cohort.ts export   ... --evidence-root <dir>
 *   npx tsx scripts/m3-cohort.ts verify   --evidence-root <dir>
 */

import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
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
  type M3Attribution,
  type M3CohortErrorCode,
  type M3ExportPayload,
  type M3SimulationProvenance,
} from '../src/m3-cohort.ts'
import { parseCohortRecord, parseManifest, scoreProductMetrics } from './product-metrics.ts'

type ParsedFlags = Record<string, string | true | Array<string | true>>

const ERROR_CODES: readonly M3CohortErrorCode[] = [
  'bad_args',
  'cohort_already_initialized',
  'cohort_consent_mismatch',
  'cohort_key_mismatch',
  'cohort_not_initialized',
  'evidence_kind_mismatch',
  'evidence_root_conflict',
  'export_validation_failed',
  'internal_error',
  'invalid_hmac_key',
  'invalid_input',
  'invalid_store',
  'invalid_transition',
  'lock_busy',
  'missing_consent',
  'missing_hmac_key',
  'missing_state_root',
  'output_exists',
  'simulation_forbidden_in_real_cohort',
  'simulation_label_required',
  'unsafe_state_root',
]

function parseFlags(args: string[]): { command: string; flags: ParsedFlags } {
  const [command, ...rest] = args
  if (!command) throw new M3CohortError('bad_args')
  const flags: ParsedFlags = {}
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index]!
    if (!token.startsWith('--')) throw new M3CohortError('bad_args')
    const key = token.slice(2)
    if (!key) throw new M3CohortError('bad_args')
    const next = rest[index + 1]
    const value: string | true = next === undefined || next.startsWith('--') ? true : (index += 1, next)
    if (key in flags) {
      const current = flags[key]
      flags[key] = Array.isArray(current) ? [...current, value] : [current!, value]
    } else {
      flags[key] = value
    }
  }
  return { command, flags }
}

function one(flags: ParsedFlags, key: string, required = true): string | undefined {
  const value = flags[key]
  if (Array.isArray(value) || value === true) throw new M3CohortError('bad_args')
  if (value === undefined && required) throw new M3CohortError(key === 'state-root' ? 'missing_state_root' : 'invalid_input')
  return value
}

function many(flags: ParsedFlags, key: string): string[] {
  const value = flags[key]
  if (value === undefined) return []
  if (value === true) throw new M3CohortError('bad_args')
  const list = Array.isArray(value) ? value : [value]
  return list.map(item => {
    if (item === true) throw new M3CohortError('bad_args')
    return item
  })
}

function boolFlag(flags: ParsedFlags, key: string): boolean {
  const value = flags[key]
  if (value === undefined) return false
  if (value !== true) throw new M3CohortError('bad_args')
  return true
}

function exclusiveBool(flags: ParsedFlags, trueKey: string, falseKey: string): boolean {
  const positive = boolFlag(flags, trueKey)
  const negative = boolFlag(flags, falseKey)
  if (positive === negative) throw new M3CohortError('invalid_input')
  return positive
}

function integerFlag(flags: ParsedFlags, key: string): number {
  const raw = one(flags, key)!
  if (!/^\d{1,9}$/.test(raw)) throw new M3CohortError('invalid_input')
  return Number(raw)
}

function common(flags: ParsedFlags) {
  const stateRoot = one(flags, 'state-root')
  const consent = one(flags, 'consent', false)
  if (!consent) throw new M3CohortError('missing_consent')
  return { stateRoot: stateRoot!, consent, hmacKey: process.env['GOTRY_M3_COHORT_HMAC_KEY'] }
}

function ensureNoUnknownFlags(flags: ParsedFlags, allowed: readonly string[]): void {
  const allowedSet = new Set(allowed)
  for (const key of Object.keys(flags)) {
    if (!allowedSet.has(key)) throw new M3CohortError('bad_args')
  }
}

function attributionFlag(flags: ParsedFlags): M3Attribution {
  const value = one(flags, 'attribution')
  if (value !== 'gotry_primary' && value !== 'gotry_assisted') throw new M3CohortError('invalid_input')
  return value
}

function attributionList(flags: ParsedFlags): M3Attribution[] {
  const values = many(flags, 'attribution')
  if (values.length === 0) throw new M3CohortError('invalid_input')
  return values.map(value => {
    if (value !== 'gotry_primary' && value !== 'gotry_assisted') throw new M3CohortError('invalid_input')
    return value
  })
}

function simulationFlags(flags: ParsedFlags): M3SimulationProvenance | undefined {
  const simulated = boolFlag(flags, 'simulated')
  const personaId = one(flags, 'persona-id', false)
  const productModel = one(flags, 'product-model', false)
  const personaModel = one(flags, 'persona-model', false)
  const promptDigest = one(flags, 'prompt-digest', false)
  const provided = [personaId, productModel, personaModel, promptDigest]
  if (!simulated) {
    if (provided.some(value => value !== undefined)) throw new M3CohortError('invalid_input')
    return undefined
  }
  if (provided.some(value => value === undefined)) throw new M3CohortError('invalid_input')
  return {
    schema_version: M3_SIMULATION_PROVENANCE_SCHEMA,
    kind: 'llm_persona',
    persona_id: personaId!,
    product_model: productModel!,
    persona_model: personaModel!,
    prompt_digest: promptDigest!,
  }
}

function output(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
}

/** Consumer-side verification: the exact parsers and scorer the M3 gate uses. */
export function scorerValidator(payload: M3ExportPayload): void {
  const manifest = parseManifest(JSON.parse(JSON.stringify(payload.manifest)))
  const cohort = payload.cohort.map((record, index) => parseCohortRecord(JSON.parse(JSON.stringify(record)), index))
  const summary = scoreProductMetrics(manifest, cohort, [])
  if (manifest.evidence_kind === 'synthetic_fixture' && summary.business_pass) {
    throw new M3CohortError('export_validation_failed')
  }
}

function run(command: string, flags: ParsedFlags): void {
  switch (command) {
    case 'init': {
      ensureNoUnknownFlags(flags, ['state-root', 'consent', 'cohort', 'evidence-kind', 'window-start', 'window-end', 'timezone', 'attribution'])
      const evidenceKind = one(flags, 'evidence-kind')
      if (evidenceKind !== 'real_seed_cohort' && evidenceKind !== 'synthetic_fixture') throw new M3CohortError('invalid_input')
      output(initM3Cohort({
        ...common(flags),
        cohort: one(flags, 'cohort')!,
        evidenceKind,
        windowStartAt: one(flags, 'window-start')!,
        windowEndAt: one(flags, 'window-end')!,
        timezone: one(flags, 'timezone')!,
        allowedAttribution: attributionList(flags),
      }))
      return
    }
    case 'enroll': {
      ensureNoUnknownFlags(flags, [
        'state-root', 'consent', 'participant', 'invited', 'not-invited', 'participant-consent',
        'participant-consent-withdrawn', 'test-or-staff', 'simulated', 'persona-id', 'product-model',
        'persona-model', 'prompt-digest',
      ])
      output(enrollParticipant({
        ...common(flags),
        participant: one(flags, 'participant')!,
        invited: exclusiveBool(flags, 'invited', 'not-invited'),
        participantConsent: exclusiveBool(flags, 'participant-consent', 'participant-consent-withdrawn'),
        testOrStaff: boolFlag(flags, 'test-or-staff'),
        simulation: simulationFlags(flags),
      }))
      return
    }
    case 'deliver': {
      ensureNoUnknownFlags(flags, ['state-root', 'consent', 'participant', 'plan', 'attribution'])
      output(recordPlanDelivered({
        ...common(flags),
        participant: one(flags, 'participant')!,
        plan: one(flags, 'plan')!,
        attribution: attributionFlag(flags),
      }))
      return
    }
    case 'finalize': {
      ensureNoUnknownFlags(flags, ['state-root', 'consent', 'participant', 'plan'])
      output(recordPlanFinalized({ ...common(flags), participant: one(flags, 'participant')!, plan: one(flags, 'plan')! }))
      return
    }
    case 'nps': {
      ensureNoUnknownFlags(flags, ['state-root', 'consent', 'participant', 'plan', 'score'])
      output(recordNps({
        ...common(flags),
        participant: one(flags, 'participant')!,
        plan: one(flags, 'plan')!,
        score: integerFlag(flags, 'score'),
      }))
      return
    }
    case 'poi-lock': {
      ensureNoUnknownFlags(flags, ['state-root', 'consent', 'participant', 'plan', 'locked-claims', 'invalid-claims'])
      output(recordPoiLock({
        ...common(flags),
        participant: one(flags, 'participant')!,
        plan: one(flags, 'plan')!,
        lockedClaims: integerFlag(flags, 'locked-claims'),
        invalidClaims: integerFlag(flags, 'invalid-claims'),
      }))
      return
    }
    case 'export': {
      ensureNoUnknownFlags(flags, ['state-root', 'consent', 'evidence-root'])
      const evidenceRoot = one(flags, 'evidence-root')!
      const { payload, result } = exportM3Cohort({ ...common(flags), evidenceRoot, validate: scorerValidator })
      // Verify the bytes that actually landed: re-read the evidence root through the real
      // scorer parsers plus the attestation check.
      const manifest = parseManifest(JSON.parse(JSON.stringify(payload.manifest)))
      const cohort = payload.cohort.map((record, index) => parseCohortRecord(JSON.parse(JSON.stringify(record)), index))
      const summary = scoreProductMetrics(manifest, cohort, [])
      const verification = verifyExportedEvidence(evidenceRoot)
      output({ ...result, verification, scorer_summary: summary })
      return
    }
    case 'verify': {
      ensureNoUnknownFlags(flags, ['evidence-root'])
      output(verifyExportedEvidence(one(flags, 'evidence-root')!))
      return
    }
    default:
      throw new M3CohortError('bad_args')
  }
}

function main(): void {
  try {
    const { command, flags } = parseFlags(process.argv.slice(2))
    run(command, flags)
  } catch (error) {
    const code: M3CohortErrorCode = error instanceof M3CohortError && ERROR_CODES.includes(error.code) ? error.code : 'internal_error'
    process.stderr.write(`m3_cohort_error:${code}\n`)
    process.exitCode = 2
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : ''
if (import.meta.url === invokedPath) main()
