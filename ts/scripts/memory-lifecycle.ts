#!/usr/bin/env tsx
/**
 * Explicit opt-in memory lifecycle collector CLI (issue #228).
 *
 * The production CLI intentionally has no --at flag: timestamps come from the
 * local clock. Tests inject clocks through ../src/memory-lifecycle.ts instead.
 */

import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  completeMemoryLifecycleFlow,
  endExternalWait,
  exportMemoryLifecycleFixture,
  initMemoryLifecycleDataset,
  MemoryLifecycleError,
  type MemoryLifecycleErrorCode,
  recordExperienceReflux,
  recordPreferenceAssertion,
  startExternalWait,
  startMemoryLifecycleFlow,
} from '../src/memory-lifecycle.ts'

type ParsedFlags = Record<string, string | true | Array<string | true>>

const ERROR_MESSAGES: Record<MemoryLifecycleErrorCode, string> = {
  bad_args: 'bad_args',
  dataset_already_initialized: 'dataset_already_initialized',
  dataset_consent_mismatch: 'dataset_consent_mismatch',
  dataset_key_mismatch: 'dataset_key_mismatch',
  dataset_not_initialized: 'dataset_not_initialized',
  dataset_source_mismatch: 'dataset_source_mismatch',
  flow_limit_reached: 'flow_limit_reached',
  internal_error: 'internal_error',
  invalid_hmac_key: 'invalid_hmac_key',
  invalid_input: 'invalid_input',
  invalid_store: 'invalid_store',
  invalid_transition: 'invalid_transition',
  lock_busy: 'lock_busy',
  missing_consent: 'missing_consent',
  missing_hmac_key: 'missing_hmac_key',
  missing_state_root: 'missing_state_root',
  output_exists: 'output_exists',
  unsafe_state_root: 'unsafe_state_root',
}

function parseFlags(args: string[]): { command: string; flags: ParsedFlags } {
  const [command, ...rest] = args
  if (!command) throw new MemoryLifecycleError('bad_args')
  const flags: ParsedFlags = {}
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index]!
    if (!token.startsWith('--')) throw new MemoryLifecycleError('bad_args')
    const key = token.slice(2)
    if (!key) throw new MemoryLifecycleError('bad_args')
    const next = rest[index + 1]
    const value: string | true = next === undefined || next.startsWith('--') ? true : (index += 1, next)
    if (key in flags) {
      const current = flags[key]
      flags[key] = Array.isArray(current) ? [...current, value] : [current, value]
    } else {
      flags[key] = value
    }
  }
  return { command, flags }
}

function one(flags: ParsedFlags, key: string, required = true): string | undefined {
  const value = flags[key]
  if (Array.isArray(value) || value === true) throw new MemoryLifecycleError('bad_args')
  if (value === undefined && required) throw new MemoryLifecycleError(key === 'state-root' ? 'missing_state_root' : 'invalid_input')
  return value
}

function many(flags: ParsedFlags, key: string): string[] {
  const value = flags[key]
  if (value === undefined) return []
  if (value === true) throw new MemoryLifecycleError('bad_args')
  return Array.isArray(value) ? value.map(item => {
    if (item === true) throw new MemoryLifecycleError('bad_args')
    return item
  }) : [value]
}

function common(flags: ParsedFlags) {
  const stateRoot = one(flags, 'state-root')
  const consent = one(flags, 'consent', false)
  if (!consent) throw new MemoryLifecycleError('missing_consent')
  return {
    stateRoot: stateRoot!,
    consent,
    hmacKey: process.env.GOTRY_MEMORY_LIFECYCLE_HMAC_KEY,
  }
}

function ensureNoUnknownFlags(flags: ParsedFlags, allowed: readonly string[]): void {
  const allowedSet = new Set(allowed)
  for (const key of Object.keys(flags)) {
    if (!allowedSet.has(key)) throw new MemoryLifecycleError('bad_args')
  }
}

function output(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
}

function run(command: string, flags: ParsedFlags): void {
  switch (command) {
    case 'init': {
      ensureNoUnknownFlags(flags, ['state-root', 'consent', 'source', 'dataset', 'wait-code'])
      const source = one(flags, 'source')
      if (source !== 'synthetic_fixture' && source !== 'observed_private') throw new MemoryLifecycleError('invalid_input')
      output(initMemoryLifecycleDataset({
        ...common(flags),
        sourceKind: source,
        dataset: one(flags, 'dataset')!,
        waitCodes: many(flags, 'wait-code'),
      }))
      return
    }
    case 'start': {
      ensureNoUnknownFlags(flags, ['state-root', 'consent', 'subject', 'flow', 'eligible-planning'])
      if (flags['eligible-planning'] !== true) throw new MemoryLifecycleError('invalid_input')
      output(startMemoryLifecycleFlow({ ...common(flags), subject: one(flags, 'subject')!, flow: one(flags, 'flow')! }))
      return
    }
    case 'wait-start': {
      ensureNoUnknownFlags(flags, ['state-root', 'consent', 'subject', 'flow', 'wait', 'code'])
      output(startExternalWait({
        ...common(flags),
        subject: one(flags, 'subject')!,
        flow: one(flags, 'flow')!,
        wait: one(flags, 'wait')!,
        code: one(flags, 'code')!,
      }))
      return
    }
    case 'wait-end': {
      ensureNoUnknownFlags(flags, ['state-root', 'consent', 'subject', 'flow', 'wait'])
      output(endExternalWait({
        ...common(flags),
        subject: one(flags, 'subject')!,
        flow: one(flags, 'flow')!,
        wait: one(flags, 'wait')!,
      }))
      return
    }
    case 'complete': {
      ensureNoUnknownFlags(flags, ['state-root', 'consent', 'subject', 'flow'])
      output(completeMemoryLifecycleFlow({ ...common(flags), subject: one(flags, 'subject')!, flow: one(flags, 'flow')! }))
      return
    }
    case 'record-reflux': {
      ensureNoUnknownFlags(flags, ['state-root', 'consent', 'experience', 'kind', 'evidence'])
      const kind = one(flags, 'kind')
      if (kind !== 'recalled' && kind !== 'verified_outcome') throw new MemoryLifecycleError('invalid_input')
      output(recordExperienceReflux({
        ...common(flags),
        experience: one(flags, 'experience')!,
        kind,
        evidence: one(flags, 'evidence')!,
      }))
      return
    }
    case 'record-preference': {
      ensureNoUnknownFlags(flags, ['state-root', 'consent', 'assertion', 'evidence', 'consumer'])
      const consumer = one(flags, 'consumer')
      if (consumer !== 'ranking' && consumer !== 'explanation') throw new MemoryLifecycleError('invalid_input')
      output(recordPreferenceAssertion({
        ...common(flags),
        assertion: one(flags, 'assertion')!,
        evidence: one(flags, 'evidence')!,
        consumer,
      }))
      return
    }
    case 'export': {
      ensureNoUnknownFlags(flags, ['state-root', 'consent', 'out'])
      const { fixture, result } = exportMemoryLifecycleFixture({ ...common(flags), out: one(flags, 'out', false) })
      if (one(flags, 'out', false)) output(result)
      else output(fixture)
      return
    }
    default:
      throw new MemoryLifecycleError('bad_args')
  }
}

function main(): void {
  try {
    const { command, flags } = parseFlags(process.argv.slice(2))
    run(command, flags)
  } catch (error) {
    const code: MemoryLifecycleErrorCode = error instanceof MemoryLifecycleError ? error.code : 'internal_error'
    process.stderr.write(`memory_lifecycle_error:${ERROR_MESSAGES[code]}\n`)
    process.exitCode = 2
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : ''
if (import.meta.url === invokedPath) main()
